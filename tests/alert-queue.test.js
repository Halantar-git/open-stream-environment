/*
 * Copyright (C) 2026  Halantar
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program.  If not, see <https://gnu.org>.
 */

/*
  Очередь алертов: что играет, что ждёт, когда меняются правила.

  Часы и таймеры инжектируются, поэтому «прошло 20 секунд» здесь — это
  переведённая вперёд переменная, а не ожидание в тесте.
*/

const { createAlertQueue } = require("../server/alert-queue");

function makeQueue(options = {}) {
  let time = 1000000;
  const timers = [];
  const played = [];
  const changes = [];

  const queue = createAlertQueue({
    clock: () => time,
    schedule: (fn, ms) => {
      const timer = { fn, at: time + ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      if (timer) timer.cancelled = true;
    },
    onPlay: (alert) => played.push(alert),
    onChange: (state) => changes.push(state),
    ...options,
  });

  return {
    queue,
    played,
    changes,
    now: () => time,
    advance(ms) {
      time += ms;
      // Запускаем всё, что «сработало» за прошедшее время, по порядку.
      let fired = true;
      while (fired) {
        fired = false;
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= time && !timer.done)
          .sort((a, b) => a.at - b.at)[0];
        if (due) {
          due.done = true;
          due.fn();
          fired = true;
        }
      }
    },
    stop: () => queue.stop(),
  };
}

const donation = (overrides = {}) => ({
  kind: "donation",
  user: "viewer",
  amount: 100,
  currency: "RUB",
  durationMs: 5000,
  ...overrides,
});

describe("alert-queue: порядок и ритм", () => {
  test("первый алерт играет сразу, остальные ждут", () => {
    const q = makeQueue();

    q.queue.enqueue(donation({ user: "a" }));
    q.queue.enqueue(donation({ user: "b" }));

    expect(q.played).toHaveLength(1);
    expect(q.played[0].user).toBe("a");
    expect(q.queue.snapshot().now.user).toBe("a");
    expect(q.queue.snapshot().items.map((item) => item.user)).toEqual(["b"]);
    q.stop();
  });

  test("следующий выходит после длительности алерта и хвоста анимации", () => {
    const q = makeQueue({ tailMs: 400 });
    q.queue.enqueue(donation({ user: "a", durationMs: 5000 }));
    q.queue.enqueue(donation({ user: "b" }));

    q.advance(5000);
    expect(q.played).toHaveLength(1); // рано: ещё идёт хвост
    q.advance(400);
    expect(q.played.map((alert) => alert.user)).toEqual(["a", "b"]);
    q.stop();
  });

  test("пока очередь пуста, ничего не происходит", () => {
    const q = makeQueue();
    q.advance(60000);

    expect(q.played).toEqual([]);
    expect(q.queue.snapshot().now).toBeNull();
    expect(q.queue.snapshot().stats.played).toBe(0);
    q.stop();
  });
});

describe("alert-queue: правила", () => {
  test("минимальная сумма отсекает мелкие донаты, но не другие события", () => {
    const q = makeQueue({ rules: { minAmount: 500 } });

    const small = q.queue.enqueue(donation({ amount: 100 }));
    const follow = q.queue.enqueue({ kind: "follow", user: "fan", durationMs: 5000 });
    const big = q.queue.enqueue(donation({ amount: 700, user: "big" }));

    expect(small.accepted).toBe(false);
    expect(small.reason).toBe("below-min-amount");
    expect(follow.accepted).toBe(true);
    expect(big.accepted).toBe(true);
    expect(q.played.map((alert) => alert.kind)).toEqual(["follow"]);
    expect(q.queue.snapshot().stats.filtered).toBe(1);
    q.stop();
  });

  test("тестовый алерт играет даже ниже порога (force)", () => {
    const q = makeQueue({ rules: { minAmount: 1000 } });

    const result = q.queue.enqueue(donation({ amount: 10, isTest: true }), { force: true });

    expect(result.accepted).toBe(true);
    expect(q.played).toHaveLength(1);
    q.stop();
  });

  test("подряд идущие донаты одного зрителя объединяются в сумму со счётчиком", () => {
    const q = makeQueue({ rules: { mergeSameUser: true, mergeWindowSec: 20 } });

    q.queue.enqueue(donation({ user: "fan", amount: 100 }));
    q.queue.enqueue(donation({ user: "fan", amount: 250 }));
    q.queue.enqueue(donation({ user: "fan", amount: 50 }));

    const snapshot = q.queue.snapshot();
    // Первый уже играет — его сумма задним числом не меняется.
    expect(snapshot.now).toMatchObject({ amount: 100 });
    // Второй и третий слились в один ожидающий алерт: сумма и счётчик.
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({ amount: 300, count: 2 });
    expect(snapshot.stats.merged).toBe(1);
    q.stop();
  });

  test("объединение работает только внутри окна", () => {
    const q = makeQueue({ rules: { mergeSameUser: true, mergeWindowSec: 10 } });

    q.queue.enqueue(donation({ user: "fan", amount: 100, durationMs: 1000 }));
    q.advance(11000); // первый уже отыграл, окно прошло
    q.queue.enqueue(donation({ user: "fan", amount: 100 }));

    expect(q.queue.snapshot().now.amount).toBe(100);
    expect(q.queue.snapshot().stats.merged).toBe(0);
    q.stop();
  });

  test("разные зрители не объединяются", () => {
    const q = makeQueue({ rules: { mergeSameUser: true, mergeWindowSec: 60 } });

    q.queue.enqueue(donation({ user: "fan", amount: 100, durationMs: 5000 }));
    q.queue.enqueue(donation({ user: "other", amount: 100 }));

    expect(q.queue.snapshot().items.map((item) => item.user)).toEqual(["other"]);
    expect(q.queue.snapshot().stats.merged).toBe(0);
    q.stop();
  });

  test("объединение можно выключить", () => {
    const q = makeQueue({ rules: { mergeSameUser: false } });

    q.queue.enqueue(donation({ user: "fan", amount: 100, durationMs: 5000 }));
    q.queue.enqueue(donation({ user: "fan", amount: 100 }));

    expect(q.queue.snapshot().items.map((item) => item.amount)).toEqual([100]);
    q.stop();
  });

  test("правила меняются на ходу", () => {
    const q = makeQueue();

    expect(q.queue.setRules({ minAmount: 300, mergeWindowSec: 5 })).toMatchObject({ minAmount: 300, mergeWindowSec: 5 });
    expect(q.queue.enqueue(donation({ amount: 200 })).accepted).toBe(false);
    expect(q.queue.enqueue(donation({ amount: 300 })).accepted).toBe(true);
    q.stop();
  });
});

describe("alert-queue: управление", () => {
  test("пропуск заканчивает текущий и запускает следующий", () => {
    const q = makeQueue();
    q.queue.enqueue(donation({ user: "a" }));
    q.queue.enqueue(donation({ user: "b" }));

    const skipped = q.queue.finishCurrent("skip");

    expect(skipped.user).toBe("a");
    expect(q.played.map((alert) => alert.user)).toEqual(["a", "b"]);
    expect(q.queue.snapshot().stats.skipped).toBe(1);
    q.stop();
  });

  test("удаление и подъём наверх меняют только ожидающих", () => {
    const q = makeQueue();
    q.queue.enqueue(donation({ user: "playing" }));
    const second = q.queue.enqueue(donation({ user: "second" }));
    const third = q.queue.enqueue(donation({ user: "third" }));

    expect(q.queue.moveUp(third.item.id)).toBe(true);
    expect(q.queue.snapshot().items.map((item) => item.user)).toEqual(["third", "second"]);
    expect(q.queue.remove(second.item.id)).toBe(true);
    expect(q.queue.snapshot().items.map((item) => item.user)).toEqual(["third"]);
    expect(q.queue.remove("нет-такого")).toBe(false);
    expect(q.queue.moveUp("нет-такого")).toBe(false);
    q.stop();
  });

  test("«проиграть сейчас» выводит выбранный алерт вперёд, текущий возвращается в очередь", () => {
    const q = makeQueue();
    q.queue.enqueue(donation({ user: "a" }));
    q.queue.enqueue(donation({ user: "b" }));
    const target = q.queue.enqueue(donation({ user: "c" }));

    expect(q.queue.playNow(target.item.id)).toBe(true);

    expect(q.queue.snapshot().now.user).toBe("c");
    expect(q.queue.snapshot().items.map((item) => item.user)).toEqual(["a", "b"]);
    expect(q.queue.playNow("нет-такого")).toBe(false);
    q.stop();
  });

  test("очистка убирает ожидающих, текущий продолжает играть", () => {
    const q = makeQueue();
    q.queue.enqueue(donation({ user: "a" }));
    q.queue.enqueue(donation({ user: "b" }));
    q.queue.enqueue(donation({ user: "c" }));

    expect(q.queue.clear()).toBe(2);

    expect(q.queue.snapshot().now.user).toBe("a");
    expect(q.queue.snapshot().items).toEqual([]);
    q.stop();
  });
});

describe("alert-queue: пауза", () => {
  test("на паузе алерты копятся, но не играют", () => {
    const q = makeQueue();
    q.queue.pause();

    q.queue.enqueue(donation({ user: "a" }));
    q.queue.enqueue(donation({ user: "b" }));

    expect(q.played).toEqual([]);
    expect(q.queue.snapshot().paused).toBe(true);
    expect(q.queue.snapshot().pending).toBe(2);

    q.queue.resume();
    expect(q.played.map((alert) => alert.user)).toEqual(["a"]);
    q.stop();
  });

  test("пауза со сроком снимается сама", () => {
    const q = makeQueue();
    q.queue.pause(5);
    q.queue.enqueue(donation({ user: "a" }));

    q.advance(4 * 60000);
    expect(q.played).toEqual([]);

    q.advance(60000 + 1);
    expect(q.played.map((alert) => alert.user)).toEqual(["a"]);
    expect(q.queue.snapshot().paused).toBe(false);
    q.stop();
  });

  test("тестовый алерт играет на паузе, и пауза остаётся", () => {
    const q = makeQueue();
    q.queue.pause();
    q.queue.enqueue(donation({ user: "waiting" }));

    q.queue.enqueue(donation({ user: "test", isTest: true }), { force: true, ignorePause: true });

    expect(q.played.map((alert) => alert.user)).toEqual(["test"]);
    expect(q.queue.snapshot().paused).toBe(true);
    // После тестового очередь снова стоит: пауза не снята.
    q.advance(10000);
    expect(q.played.map((alert) => alert.user)).toEqual(["test"]);
    q.stop();
  });

  test("пауза восстанавливается из конфига и истекает по сроку", () => {
    const q = makeQueue();

    expect(q.queue.restorePause(q.now() + 10 * 60000)).toBe(true);
    expect(q.queue.snapshot().paused).toBe(true);
    expect(q.queue.snapshot().pausedUntil).toBe(q.now() + 10 * 60000);
    q.stop();
  });

  test("истёкший срок из конфига паузой не считается", () => {
    const q = makeQueue();

    expect(q.queue.restorePause(q.now() - 1000)).toBe(false);
    expect(q.queue.snapshot().paused).toBe(false);
    q.stop();
  });
});

describe("alert-queue: наблюдаемость", () => {
  test("снимок содержит то, что нужно панели", () => {
    const q = makeQueue();
    q.queue.enqueue(donation({ user: "a" }));
    q.queue.enqueue(donation({ user: "b" }));

    const snapshot = q.queue.snapshot();

    expect(snapshot).toMatchObject({
      paused: false,
      pending: 1,
      rules: { minAmount: 0, mergeSameUser: true, mergeWindowSec: 20 },
      stats: { received: 2, played: 1 },
    });
    expect(snapshot.now).toMatchObject({ user: "a", kind: "donation", amount: 100 });
    expect(snapshot.now.id).toBeTruthy();
    expect(snapshot.items[0]).toMatchObject({ user: "b" });
    q.stop();
  });

  test("изменения рассылаются с причиной", () => {
    const q = makeQueue();
    q.queue.enqueue(donation({ user: "a" }));

    const reasons = q.changes.map((state) => state.reason);
    expect(reasons).toEqual(["queued", "playing"]);
    // Снимок на момент старта проигрывания: алерт ушёл в эфир, ожидающих нет.
    expect(q.changes[1]).toMatchObject({ pending: 0, now: { user: "a" } });
    q.stop();
  });

  test("пустой объект в очередь не попадает", () => {
    const q = makeQueue();

    expect(q.queue.enqueue(null).accepted).toBe(false);
    expect(q.queue.enqueue(undefined).accepted).toBe(false);
    expect(q.queue.snapshot().stats.received).toBe(0);
    q.stop();
  });
});

describe("alert-queue: подтянутые с DonationAlerts донаты", () => {
  test("признак «пропущенный» едет вместе с алертом и считается в статистике", () => {
    const q = makeQueue();

    q.queue.enqueue(donation({ user: "missed" }), { recovered: true });

    expect(q.queue.snapshot().now.recovered).toBe(true);
    expect(q.queue.snapshot().stats.recovered).toBe(1);
    q.stop();
  });

  test("обычный донат пропущенным не считается", () => {
    const q = makeQueue();

    q.queue.enqueue(donation({ user: "live" }));

    expect(q.queue.snapshot().now.recovered).toBe(false);
    expect(q.queue.snapshot().stats.recovered).toBe(0);
    q.stop();
  });

  test("id доната на стороне сервиса сохраняется: по нему пропущенное не подтянется дважды", () => {
    const q = makeQueue();

    q.queue.enqueue(donation({ user: "missed", sourceId: 42 }), { recovered: true });

    // Через очередь id едет строкой: конфиг и история хранят его так же.
    expect(q.queue.snapshot().now.sourceId).toBe("42");
    q.stop();
  });

  test("подтянутое объединяется по тем же правилам, что и живое", () => {
    const q = makeQueue({ rules: { mergeSameUser: true, mergeWindowSec: 20 } });

    q.queue.enqueue(donation({ user: "fan", amount: 100 })); // играет сразу
    q.queue.enqueue(donation({ user: "fan", amount: 50 }));
    q.queue.enqueue(donation({ user: "fan", amount: 25 }), { recovered: true });

    const waiting = q.queue.snapshot().items[0];
    expect(waiting).toMatchObject({ user: "fan", amount: 75, count: 2 });
    // Объединённый алерт помнит, что внутри было пропущенное.
    expect(waiting.recovered).toBe(true);
    // А играющий задним числом не меняется: виджет уже нарисовал сумму.
    expect(q.queue.snapshot().now).toMatchObject({ amount: 100, count: 0 });
    q.stop();
  });

  test("подтянутое подчиняется правилу минимальной суммы", () => {
    const q = makeQueue({ rules: { minAmount: 500 } });

    const result = q.queue.enqueue(donation({ user: "tiny", amount: 10 }), { recovered: true });

    // Правило одно на все донаты: подтянутый донат — такой же донат, как живой.
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("below-min-amount");
    expect(q.queue.snapshot().stats.filtered).toBe(1);
    q.stop();
  });
});
