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

const EventBus = require("../overlay/event-bus");
const { EVENT_TYPES } = require("../shared/events");
const WebcamWidget = require("../overlay/widgets/webcam-widget");

// ---- minimal DOM mock ----

function makeEl(tag) {
  const classSet = new Set();
  const el = {
    tagName: (tag || "div").toUpperCase(),
    className: "",
    dataset: {},
    innerHTML: "",
    style: {
      values: {},
      setProperty(k, v) {
        this.values[k] = v;
      },
    },
    classList: {
      add: (...c) => c.forEach((x) => classSet.add(x)),
      remove: (...c) => c.forEach((x) => classSet.delete(x)),
      toggle: (c, f) => {
        const on = f === undefined ? !classSet.has(c) : f;
        if (on) classSet.add(c);
        else classSet.delete(c);
        return on;
      },
      contains: (c) => classSet.has(c),
    },
    children: [],
    parentNode: null,
    isConnected: true,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    querySelector(selector) {
      // Виджет после render() берёт canvas и заглушку через querySelector;
      // мок отдаёт стабильные элементы, чтобы проверять зеркало и "нет сигнала".
      if (selector === ".widget-webcam__video") {
        if (!this._videoCanvas) this._videoCanvas = makeEl("canvas");
        return this._videoCanvas;
      }
      if (selector === ".widget-webcam__audio") {
        if (!this._audioEl) this._audioEl = makeEl("audio");
        return this._audioEl;
      }
      if (selector === ".widget-webcam__empty") {
        if (!this._emptyEl) this._emptyEl = makeEl("div");
        return this._emptyEl;
      }
      return null;
    },
    getContext() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return el;
}

function makeContext() {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    t: (key) => key,
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    send: jest.fn(),
  };
}

function makeItem(config = {}) {
  return { id: "webcam-1", type: "webcam", x: 20, y: 30, w: 24, h: 24, z: 0, visible: true, config };
}

function mount(config = {}) {
  const parent = makeEl("div");
  const w = new WebcamWidget(makeItem(config), makeContext());
  w.mount(parent);
  return w;
}

let originalGlobals;

beforeEach(() => {
  originalGlobals = { document: global.document, window: global.window };
  global.document = { createElement: (tag) => makeEl(tag) };
  global.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
});

afterEach(() => {
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
});

describe("WebcamWidget", () => {
  test("по умолчанию рисует рамку, четыре уголка и бейдж LIVE", () => {
    const w = mount();

    expect(w.host.className).toBe("widget-webcam");
    expect(w.element.dataset.type).toBe("webcam");
    expect(w.host.innerHTML).toContain("widget-webcam__frame");
    expect(w.host.innerHTML.match(/widget-webcam__corner/g)).toHaveLength(4);
    expect(w.host.innerHTML).toContain('data-pos="top-left"');
    expect(w.host.innerHTML).toContain("LIVE");
    expect(w.host.innerHTML).toContain("widget-webcam__dot");
    expect(w.host.innerHTML).not.toContain("widget-webcam__backdrop");
    expect(w.host.innerHTML).not.toContain("widget-webcam__vignette");
  });

  test("толщина, скругление и цвет уходят в CSS-переменные", () => {
    const w = mount({ color: "#ff5500", thickness: 8, radius: 24 });

    expect(w.host.style.values["--webcam-accent"]).toBe("#ff5500");
    expect(w.host.style.values["--webcam-thickness"]).toBe("8px");
    expect(w.host.style.values["--webcam-radius"]).toBe("24px");
  });

  test("без цвета рамка берёт акцент темы", () => {
    const w = mount({ color: "" });
    expect(w.host.style.values["--webcam-accent"]).toBe("var(--md-primary)");
  });

  test("без явного радиуса повторяет скругление темы", () => {
    const rounded = new WebcamWidget(makeItem({}), {
      ...makeContext(),
      readCssVar: (name) => (name === "--panel-radius" ? "24px" : ""),
    });
    rounded.mount(makeEl("div"));
    expect(rounded.host.style.values["--webcam-radius"]).toBe("24px");
    rounded.unmount();

    const sharp = new WebcamWidget(makeItem({}), {
      ...makeContext(),
      readCssVar: (name) => (name === "--panel-radius" ? "0px" : ""),
    });
    sharp.mount(makeEl("div"));
    expect(sharp.host.style.values["--webcam-radius"]).toBe("0px");
    sharp.unmount();
  });

  test("явный радиус перекрывает тему", () => {
    const w = new WebcamWidget(makeItem({ radius: 16, radiusAuto: false }), {
      ...makeContext(),
      readCssVar: () => "0px",
    });
    w.mount(makeEl("div"));
    expect(w.host.style.values["--webcam-radius"]).toBe("16px");
    w.unmount();
  });

  test("старый дефолт 16px считается автоматическим", () => {
    const w = new WebcamWidget(makeItem({ radius: 16 }), {
      ...makeContext(),
      readCssVar: () => "0px",
    });
    w.mount(makeEl("div"));
    expect(w.host.style.values["--webcam-radius"]).toBe("0px");
    w.unmount();
  });

  test("небезопасное значение цвета не попадает в CSS", () => {
    const w = mount({ color: 'red; background:url("x")' });
    expect(w.host.style.values["--webcam-accent"]).toBe("var(--md-primary)");
  });

  test("бейдж можно скрыть или очистить", () => {
    expect(mount({ showLabel: false }).host.innerHTML).not.toContain("widget-webcam__label");
    expect(mount({ label: "   " }).host.innerHTML).not.toContain("widget-webcam__label");
  });

  test("положение бейджа и произвольная подпись", () => {
    const w = mount({ label: "REC", labelPosition: "bottom-right" });
    expect(w.host.innerHTML).toContain('data-pos="bottom-right"');
    expect(w.host.innerHTML).toContain("REC");
  });

  test("неизвестное положение бейджа сбрасывается в левый верхний угол", () => {
    const w = mount({ labelPosition: "somewhere" });
    expect(w.host.innerHTML).toContain('data-pos="top-left"');
  });

  test("рамку, уголки, фон и затемнение можно отключить по отдельности", () => {
    const w = mount({ showBorder: false, showCorners: false, showBackground: false, showVignette: false });
    expect(w.host.innerHTML).not.toContain("widget-webcam__frame");
    expect(w.host.innerHTML).not.toContain("widget-webcam__corner");
    expect(w.host.innerHTML).not.toContain("widget-webcam__backdrop");
    expect(w.host.innerHTML).not.toContain("widget-webcam__vignette");
  });

  test("фон и затемнение добавляются, когда включены", () => {
    const w = mount({ showBackground: true, showVignette: true });
    expect(w.host.innerHTML).toContain("widget-webcam__backdrop");
    expect(w.host.innerHTML).toContain("widget-webcam__vignette");
  });

  test("update перерисовывает рамку под новый конфиг", () => {
    const w = mount({ label: "LIVE" });
    w.update({ config: { label: "STREAM", labelPosition: "bottom-left", thickness: 2 } });

    expect(w.host.innerHTML).toContain("STREAM");
    expect(w.host.innerHTML).not.toContain(">LIVE<");
    expect(w.host.innerHTML).toContain('data-pos="bottom-left"');
    expect(w.host.style.values["--webcam-thickness"]).toBe("2px");
  });

  test("числовые настройки зажимаются в допустимый диапазон", () => {
    const w = mount({ thickness: 999, radius: -10 });
    expect(w.host.style.values["--webcam-thickness"]).toBe("16px");
    expect(w.host.style.values["--webcam-radius"]).toBe("0px");
  });

  test("в режиме камеры рисует видео-слой и заглушку", () => {
    const w = mount({ source: "camera", fit: "contain" });

    expect(w.host.innerHTML).toContain("widget-webcam__video-wrap");
    expect(w.host.innerHTML).toContain("widget-webcam__video");
    expect(w.host.innerHTML).toContain('data-fit="contain"');
    expect(w.host.innerHTML).toContain("webcam.noSignal");
  });

  test("в режиме рамки видео-слоя нет", () => {
    const w = mount({ source: "frame" });
    expect(w.host.innerHTML).not.toContain("widget-webcam__video-wrap");
  });

  test("гостевая камера подписывается на выбранный слот", () => {
    const w = mount({ source: "remote", guestSlot: "cam2" });

    expect(w.host.innerHTML).toContain("<video");
    expect(w.host.innerHTML).toContain("widget-webcam__audio");
    expect(w.context.send).toHaveBeenCalledWith(EVENT_TYPES.CMD_GUEST_SUBSCRIBE, { slot: "cam2" });
  });

  test("гостевая камера без слота просит его выбрать и не подписывается", () => {
    const w = mount({ source: "remote", guestSlot: "" });

    expect(w.host.innerHTML).toContain("webcam.guestNoSlot");
    expect(w.context.send).not.toHaveBeenCalledWith(EVENT_TYPES.CMD_GUEST_SUBSCRIBE, { slot: "" });
  });

  test("подтверждение гостя создаёт peer, а offer получает answer", async () => {
    const created = [];
    class FakePeer {
      constructor() {
        this.remoteDescription = null;
        this.localDescription = null;
        this.connectionState = "new";
        created.push(this);
      }
      close() {}
      setRemoteDescription(desc) {
        this.remoteDescription = desc;
        return Promise.resolve();
      }
      createAnswer() {
        return Promise.resolve({ type: "answer", sdp: "v=0 answer" });
      }
      setLocalDescription(desc) {
        this.localDescription = desc;
        return Promise.resolve();
      }
      addIceCandidate() {
        return Promise.resolve();
      }
    }
    const previous = global.RTCPeerConnection;
    global.RTCPeerConnection = FakePeer;
    try {
      const w = mount({ source: "remote", guestSlot: "cam2" });
      w.context.bus.emit(EVENT_TYPES.GUEST_ACCEPTED, { slot: "cam2" });
      expect(created).toHaveLength(1);

      w.context.bus.emit(EVENT_TYPES.GUEST_SIGNAL, {
        slot: "cam2",
        payload: { type: "offer", sdp: "v=0 offer" },
      });
      // `_applyGuestOffer` асинхронный: даём ему завершить цепочку promise.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(created[0].remoteDescription).toEqual({ type: "offer", sdp: "v=0 offer" });
      expect(w.context.send).toHaveBeenCalledWith(EVENT_TYPES.GUEST_SIGNAL, {
        slot: "cam2",
        payload: { type: "answer", sdp: "v=0 answer" },
      });
    } finally {
      global.RTCPeerConnection = previous;
    }
  });

  test("повторное обновление повторяет подписку на слот", () => {
    const w = mount({ source: "remote", guestSlot: "cam2" });
    const count = () =>
      w.context.send.mock.calls.filter(([type]) => type === EVENT_TYPES.CMD_GUEST_SUBSCRIBE).length;
    const before = count();

    // Снимок состояния приходит и после перезапуска сервера: подписка должна
    // восстановиться сама, а не ждать перезагрузки OBS.
    w.update({ config: { label: "LIVE" } });

    expect(count()).toBeGreaterThan(before);
  });

  test("offer без подтверждения создаёт peer сам", async () => {
    const created = [];
    class FakePeer {
      constructor() {
        this.remoteDescription = null;
        this.localDescription = null;
        this.connectionState = "new";
        created.push(this);
      }
      close() {}
      setRemoteDescription(desc) {
        this.remoteDescription = desc;
        return Promise.resolve();
      }
      createAnswer() {
        return Promise.resolve({ type: "answer", sdp: "v=0 answer" });
      }
      setLocalDescription(desc) {
        this.localDescription = desc;
        return Promise.resolve();
      }
      addIceCandidate() {
        return Promise.resolve();
      }
    }
    const previous = global.RTCPeerConnection;
    global.RTCPeerConnection = FakePeer;
    try {
      const w = mount({ source: "remote", guestSlot: "cam2" });
      // Приёмник подписался уже после подтверждения: `guest_accepted` он не видел.
      w.context.bus.emit(EVENT_TYPES.GUEST_SIGNAL, {
        slot: "cam2",
        payload: { type: "offer", sdp: "v=0 offer" },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(created).toHaveLength(1);
      expect(w.context.send).toHaveBeenCalledWith(EVENT_TYPES.GUEST_SIGNAL, {
        slot: "cam2",
        payload: { type: "answer", sdp: "v=0 answer" },
      });
    } finally {
      global.RTCPeerConnection = previous;
    }
  });

  test("зеркало применяется к canvas и снимается при обновлении", () => {
    const w = mount({ source: "camera", mirror: true });
    expect(w.videoCanvas.style.transform).toBe("scaleX(-1)");

    w.update({ config: { mirror: false } });
    expect(w.videoCanvas.style.transform).toBe("");
  });

  test("H.264: конфиг создаёт декодер, ключевой чанк уходит в decode", () => {
    const originalDecoder = global.VideoDecoder;
    const originalChunk = global.EncodedVideoChunk;
    const decoded = [];
    global.VideoDecoder = class {
      constructor(init) {
        this.init = init;
        this.state = "unconfigured";
      }
      configure(config) {
        this.config = config;
        this.state = "configured";
      }
      decode(chunk) {
        decoded.push(chunk);
      }
      close() {
        this.state = "closed";
      }
    };
    global.EncodedVideoChunk = class {
      constructor(init) {
        Object.assign(this, init);
      }
    };

    try {
      const w = mount({ source: "camera" });
      w.context.bus.emit(EVENT_TYPES.CAMERA_STREAM_CONFIG, {
        codec: "avc1.64002A",
        width: 960,
        height: 540,
      });

      expect(w.videoDecoder).toBeTruthy();
      expect(w.videoDecoder.config.codec).toBe("avc1.64002A");
      expect(w.videoDecoder.config.codedWidth).toBe(960);

      w.context.bus.emit(EVENT_TYPES.CAMERA_VIDEO_FRAME, {
        h264: true,
        keyframe: true,
        timestamp: 42,
        data: new Uint8Array([1, 2, 3]),
      });

      expect(decoded).toHaveLength(1);
      expect(decoded[0].type).toBe("key");
      expect(decoded[0].timestamp).toBe(42);
    } finally {
      if (originalDecoder === undefined) delete global.VideoDecoder;
      else global.VideoDecoder = originalDecoder;
      if (originalChunk === undefined) delete global.EncodedVideoChunk;
      else global.EncodedVideoChunk = originalChunk;
    }
  });

  test("H.264: повторный тот же конфиг не пересоздаёт декодер", () => {
    const originalDecoder = global.VideoDecoder;
    const originalChunk = global.EncodedVideoChunk;
    let created = 0;
    global.VideoDecoder = class {
      constructor() {
        created += 1;
        this.state = "unconfigured";
      }
      configure() {
        this.state = "configured";
      }
      decode() {}
      close() {
        this.state = "closed";
      }
    };
    global.EncodedVideoChunk = class {};

    try {
      const w = mount({ source: "camera" });
      const config = { codec: "avc1.64002A", width: 960, height: 540 };
      w.context.bus.emit(EVENT_TYPES.CAMERA_STREAM_CONFIG, config);
      w.context.bus.emit(EVENT_TYPES.CAMERA_STREAM_CONFIG, { ...config });

      expect(created).toBe(1);
    } finally {
      if (originalDecoder === undefined) delete global.VideoDecoder;
      else global.VideoDecoder = originalDecoder;
      if (originalChunk === undefined) delete global.EncodedVideoChunk;
      else global.EncodedVideoChunk = originalChunk;
    }
  });

  test("H.264: без VideoDecoder оверлей просит JPEG", () => {
    const originalDecoder = global.VideoDecoder;
    const originalChunk = global.EncodedVideoChunk;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    delete global.VideoDecoder;
    delete global.EncodedVideoChunk;

    try {
      const w = mount({ source: "camera" });
      w.context.bus.emit(EVENT_TYPES.CAMERA_STREAM_CONFIG, {
        codec: "avc1.64002A",
        width: 960,
        height: 540,
      });

      expect(w.context.send).toHaveBeenCalledWith(EVENT_TYPES.CMD_CAMERA_DECODE_FAILED, {
        reason: "no-video-decoder",
      });
    } finally {
      warn.mockRestore();
      if (originalDecoder === undefined) delete global.VideoDecoder;
      else global.VideoDecoder = originalDecoder;
      if (originalChunk === undefined) delete global.EncodedVideoChunk;
      else global.EncodedVideoChunk = originalChunk;
    }
  });

  test("кадр из моста рисуется и скрывает заглушку", () => {
    const originalImage = global.Image;
    const originalURL = global.URL;
    const revoke = jest.fn();
    global.URL = { createObjectURL: () => "blob:frame", revokeObjectURL: revoke };
    global.Image = class {
      set src(value) {
        this._src = value;
        if (this.onload) this.onload();
      }
      get src() {
        return this._src;
      }
      get naturalWidth() {
        return 640;
      }
      get naturalHeight() {
        return 360;
      }
    };

    try {
      const w = mount({ source: "camera" });
      w.context.bus.emit(EVENT_TYPES.CAMERA_VIDEO_FRAME, { blob: {} });

      expect(w._hasFrame).toBe(true);
      expect(w.emptyEl).toBeNull();
      expect(revoke).toHaveBeenCalledWith("blob:frame");
    } finally {
      global.Image = originalImage;
      global.URL = originalURL;
    }
  });

  test("перспектива наклоняет виджет и учитывает направление", () => {
    const w = mount({ perspective: 50, perspectiveDirection: "left" });
    expect(w.element.style.transform).toContain("perspective(1200px)");
    expect(w.element.style.transform).toContain("rotateY(-7.5deg)");
    expect(w.element.style.transform).toContain("rotateX(1.5deg)");
    expect(w.element.style.transformStyle).toBe("preserve-3d");

    w.update({ config: { perspectiveDirection: "right" } });
    expect(w.element.style.transform).toContain("rotateY(7.5deg)");

    w.update({ config: { perspectiveDirection: "up" } });
    expect(w.element.style.transform).toContain("rotateY(0deg)");
    expect(w.element.style.transform).toContain("rotateX(7.5deg)");

    w.update({ config: { perspectiveDirection: "down" } });
    expect(w.element.style.transform).toContain("rotateX(-7.5deg)");

    w.update({ config: { perspective: 0 } });
    expect(w.element.style.transform).toBe("");
    expect(w.element.style.transformStyle).toBe("");
  });

  test("unmount снимает виджет с канваса", () => {
    const w = mount();
    const parent = w.element.parentNode;
    w.unmount();
    expect(parent.children).toHaveLength(0);
  });
});
