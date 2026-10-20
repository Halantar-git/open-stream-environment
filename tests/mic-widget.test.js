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
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://gnu.org>.
 */

const MicWidget = require("../overlay/widgets/mic-widget");

function widget(config) {
  const instance = new MicWidget({ type: "mic", config }, {});
  instance.element = { style: {} };
  return instance;
}

describe("MicWidget: перспектива", () => {
  test("наклоняется вправо с той же силой, что и 3D-виджеты", () => {
    const w = widget({ perspective: 50, perspectiveDirection: "right" });
    w._applyPerspective();

    expect(w.element.style.transform).toBe(
      "perspective(1200px) rotateY(7.5deg) rotateX(1.5deg)"
    );
    expect(w.element.style.transformStyle).toBe("preserve-3d");
  });

  test("по умолчанию наклон влево", () => {
    const w = widget({ perspective: 50 });
    w._applyPerspective();

    expect(w.element.style.transform).toBe(
      "perspective(1200px) rotateY(-7.5deg) rotateX(1.5deg)"
    );
  });

  test("направления вверх и вниз меняют ось", () => {
    const up = widget({ perspective: 100, perspectiveDirection: "up" });
    up._applyPerspective();
    expect(up.element.style.transform).toBe(
      "perspective(1200px) rotateY(0deg) rotateX(15deg)"
    );

    const down = widget({ perspective: 100, perspectiveDirection: "down" });
    down._applyPerspective();
    expect(down.element.style.transform).toBe(
      "perspective(1200px) rotateY(0deg) rotateX(-15deg)"
    );
  });

  test("нулевая перспектива убирает трансформацию", () => {
    const w = widget({ perspective: 0 });
    w.element.style.transform = "old";
    w.element.style.transformStyle = "preserve-3d";

    w._applyPerspective();
    expect(w.element.style.transform).toBe("");
    expect(w.element.style.transformStyle).toBe("");
  });

  test("сила зажимается в 0–100", () => {
    const over = widget({ perspective: 500, perspectiveDirection: "up" });
    over._applyPerspective();
    expect(over.element.style.transform).toBe(
      "perspective(1200px) rotateY(0deg) rotateX(15deg)"
    );

    const below = widget({ perspective: -50 });
    below._applyPerspective();
    expect(below.element.style.transform).toBe("");
  });

  test("обновление конфига сразу применяет наклон", () => {
    const w = new MicWidget({ type: "mic", config: { perspective: 0 } }, {});
    w.element = { style: {} };

    w.update({ type: "mic", config: { perspective: 50, perspectiveDirection: "right" } });
    expect(w.element.style.transform).toBe(
      "perspective(1200px) rotateY(7.5deg) rotateX(1.5deg)"
    );
  });
});

// `_draw` работает с canvas и window напрямую, поэтому проверяем через
// подменённые контекст и холст: так видны и размеры области рисования, и сама
// трансформация, не поднимая браузер.
function drawContext() {
  return {
    rects: [],
    calls: [],
    curves: 0,
    fills: 0,
    strokes: 0,
    globalAlpha: 1,
    setTransform() {},
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {
      this.curves += 1;
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
    stroke() {
      this.strokes += 1;
    },
    fill() {
      this.fills += 1;
    },
    fillRect(x, y, w, h) {
      this.rects.push({ x, y, w, h });
    },
    translate(x, y) {
      this.calls.push({ op: "translate", x, y });
    },
    rotate(a) {
      this.calls.push({ op: "rotate", a });
    },
    scale(x, y) {
      this.calls.push({ op: "scale", x, y });
    },
  };
}

function drawableWidget(config) {
  const w = widget(config);
  w.context = { readCssVar: () => "#123456", state: {}, t: (key) => key };
  w.host = { clientWidth: 320, clientHeight: 96 };
  w.micCanvas = { width: 0, height: 0 };
  w.micCtx = drawContext();
  return w;
}

describe("MicWidget: источник данных", () => {
  beforeEach(() => {
    global.window = { devicePixelRatio: 1 };
  });
  afterEach(() => {
    delete global.window;
  });

  function remote(level) {
    return {
      level,
      wave: new Uint8Array(240).fill(180),
      freq: new Uint8Array(128).fill(220),
    };
  }

  // В OBS локальный захват может разрешиться, но отдавать тишину (устройство
  // занято панелью). Кадры моста должны перекрывать такой поток, иначе
  // визуализатор замирает на нулях.
  test("живые кадры панели важнее молчащего локального захвата", () => {
    const w = drawableWidget({ visualizer_mode: "bars" });
    const frame = remote(0.8);
    w.context.state = { remoteMicData: frame };
    w.dataArray = new Uint8Array(2048);
    w.freqArray = new Uint8Array(1024);
    w.analyser = {
      getByteTimeDomainData(arr) {
        arr.fill(128);
      },
      getByteFrequencyData(arr) {
        arr.fill(0);
      },
    };
    const bars = jest.spyOn(w, "_drawBars").mockImplementation(() => {});

    w._draw(1000);
    w._draw(1100);

    expect(bars).toHaveBeenCalled();
    // Полосы собраны из кадра панели, а не из локального (молчащего) потока.
    // Первый кадр только заводит сглаживание (dt = 0), поэтому смотрим второй.
    expect(Math.max(...bars.mock.calls[1][3])).toBeGreaterThan(0.5);
    expect(w.level).toBeGreaterThan(0.5);
  });

  // Обратный случай: устройство первым забрал оверлей, и панель шлёт нули.
  test("живой локальный захват важнее молчащих кадров панели", () => {
    const w = drawableWidget({ visualizer_mode: "bars" });
    w.context.state = { remoteMicData: remote(0) };
    w.dataArray = new Uint8Array(2048).fill(170);
    w.freqArray = new Uint8Array(1024);
    w.analyser = {
      getByteTimeDomainData(arr) {
        arr.fill(170);
      },
      getByteFrequencyData(arr) {
        arr.fill(190);
      },
    };
    const bars = jest.spyOn(w, "_drawBars").mockImplementation(() => {});

    w._draw(1000);
    w._draw(1100);

    expect(Math.max(...bars.mock.calls[1][3])).toBeGreaterThan(0.5);
    expect(w.level).toBeGreaterThan(0);
  });

  test("без кадров панели работает локальный захват", () => {
    const w = drawableWidget({ visualizer_mode: "bars" });
    w.dataArray = new Uint8Array(2048).fill(170);
    w.freqArray = new Uint8Array(1024).fill(190);
    w.analyser = {
      getByteTimeDomainData(arr) {
        arr.fill(170);
      },
      getByteFrequencyData(arr) {
        arr.fill(190);
      },
    };
    const bars = jest.spyOn(w, "_drawBars").mockImplementation(() => {});

    w._draw(1000);
    w._draw(1100);

    expect(Math.max(...bars.mock.calls[1][3])).toBeGreaterThan(0.5);
    expect(w.level).toBeGreaterThan(0);
  });

  test("замолчавший мост уступает локальному захвату", () => {
    const w = drawableWidget({ visualizer_mode: "bars" });
    w.dataArray = new Uint8Array(2048).fill(170);
    w.freqArray = new Uint8Array(1024).fill(80);
    w.analyser = {
      getByteTimeDomainData(arr) {
        arr.fill(170);
      },
      getByteFrequencyData(arr) {
        arr.fill(80);
      },
    };
    const frame = remote(0.8);
    frame.freq.fill(255);
    w.context.state = { remoteMicData: frame };
    const bars = jest.spyOn(w, "_drawBars").mockImplementation(() => {});

    w._draw(1000);
    w._draw(1100);
    // Свежие кадры панели: громкий спектр 255.
    expect(Math.max(...bars.mock.calls[1][3])).toBeGreaterThan(0.9);

    // Кадров нет — источник переключился на локальный спектр 80.
    w._draw(1600);
    w._draw(2000);
    w._draw(2400);
    expect(Math.max(...bars.mock.calls.at(-1)[3])).toBeLessThan(0.5);
  });
});

describe("MicWidget: режимы", () => {
  test("столбики снизу вверх растут от нижнего края", () => {
    const w = widget({});
    const ctx = drawContext();
    w._drawBarsUp(ctx, 200, 80, [0.25, 0.5, 1], 2);

    expect(ctx.rects).toHaveLength(3);
    for (const r of ctx.rects) expect(r.y + r.h).toBeCloseTo(80, 5);
    expect(ctx.rects[2].h).toBeGreaterThan(ctx.rects[0].h);
  });

  test("столбики от центра остаются симметричными", () => {
    const w = widget({});
    const ctx = drawContext();
    w._drawBars(ctx, 200, 80, [0.25, 0.5, 1], 2);

    for (const r of ctx.rects) expect(r.y + r.h / 2).toBeCloseTo(40, 5);
  });

  test("огибающая сглаживает спектр и заливает площадь под ним", () => {
    const w = widget({});
    const ctx = drawContext();
    w._drawCurve(ctx, 200, 80, [0.2, 0.6, 1, 0.4]);

    // По квадратичной кривой на каждый отрезок между полосами плюс замыкающая.
    expect(ctx.curves).toBe(4);
    expect(ctx.fills).toBe(1);
    expect(ctx.strokes).toBe(1);
  });
});

describe("MicWidget: поворот", () => {
  beforeEach(() => {
    global.window = { devicePixelRatio: 1 };
  });
  afterEach(() => {
    delete global.window;
  });

  test("90° меняет местами ширину и высоту области рисования", () => {
    const w = drawableWidget({ visualizer_mode: "sine", rotation: 90 });
    const sine = jest.spyOn(w, "_drawSine").mockImplementation(() => {});

    w._draw(1000);

    // Виджет 320×96, поэтому рисуем в области 96×320 — иначе картинка обрезалась бы.
    expect(sine.mock.calls[0].slice(1, 3)).toEqual([96, 320]);
    expect(w.micCtx.calls).toEqual([
      { op: "translate", x: 320, y: 0 },
      { op: "rotate", a: Math.PI / 2 },
    ]);
  });

  test("270° поворачивает в обратную сторону", () => {
    const w = drawableWidget({ visualizer_mode: "sine", rotation: 270 });
    const sine = jest.spyOn(w, "_drawSine").mockImplementation(() => {});

    w._draw(1000);

    expect(sine.mock.calls[0].slice(1, 3)).toEqual([96, 320]);
    expect(w.micCtx.calls).toEqual([
      { op: "translate", x: 0, y: 96 },
      { op: "rotate", a: -Math.PI / 2 },
    ]);
  });

  test("180° разворачивает картинку на месте", () => {
    const w = drawableWidget({ visualizer_mode: "sine", rotation: 180 });
    const sine = jest.spyOn(w, "_drawSine").mockImplementation(() => {});

    w._draw(1000);

    expect(sine.mock.calls[0].slice(1, 3)).toEqual([320, 96]);
    expect(w.micCtx.calls).toEqual([
      { op: "translate", x: 320, y: 96 },
      { op: "rotate", a: Math.PI },
    ]);
  });

  test("неизвестный угол не поворачивает холст", () => {
    const w = drawableWidget({ visualizer_mode: "sine", rotation: 45 });
    const sine = jest.spyOn(w, "_drawSine").mockImplementation(() => {});

    w._draw(1000);

    expect(sine.mock.calls[0].slice(1, 3)).toEqual([320, 96]);
    expect(w.micCtx.calls).toEqual([]);
  });

  test("режим столбиков снизу вверх получает повёрнутую область", () => {
    const w = drawableWidget({ visualizer_mode: "bars-up", rotation: 180 });
    const bars = jest.spyOn(w, "_drawBarsUp").mockImplementation(() => {});

    w._draw(1000);

    // Без анализатора спектра нет — виджет рисует пустоту, но в правильных координатах.
    expect(bars).toHaveBeenCalledWith(w.micCtx, 320, 96, null, 2);
    expect(w.micCtx.calls).toEqual([
      { op: "translate", x: 320, y: 96 },
      { op: "rotate", a: Math.PI },
    ]);
  });

  test("режим огибающей получает ту же область, что и столбики", () => {
    const w = drawableWidget({ visualizer_mode: "curve" });
    const curve = jest.spyOn(w, "_drawCurve").mockImplementation(() => {});

    w._draw(1000);

    expect(curve).toHaveBeenCalledWith(w.micCtx, 320, 96, null);
    expect(w.micCtx.calls).toEqual([]);
  });

  test("зеркало отражает рисунок после поворота", () => {
    const w = drawableWidget({ visualizer_mode: "sine", rotation: 90, mirror: true });
    jest.spyOn(w, "_drawSine").mockImplementation(() => {});

    w._draw(1000);

    // Сначала поворот в рамку, затем отражение по оси уже повёрнутой области.
    expect(w.micCtx.calls).toEqual([
      { op: "translate", x: 320, y: 0 },
      { op: "rotate", a: Math.PI / 2 },
      { op: "translate", x: 96, y: 0 },
      { op: "scale", x: -1, y: 1 },
    ]);
  });

  test("без зеркала холст не отражается", () => {
    const w = drawableWidget({ visualizer_mode: "sine", mirror: false });
    jest.spyOn(w, "_drawSine").mockImplementation(() => {});

    w._draw(1000);

    expect(w.micCtx.calls.some((call) => call.op === "scale")).toBe(false);
  });
});
