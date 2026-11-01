/*
  Типы публичного API пакетов Open Stream Environment (`window.OSE`).

  Подключение в своём пакете — один раз в начале JS-файла:

    /// <reference path="../sdk/index.d.ts" />
    // @ts-check

  После этого редактор подсказывает поля `this.config`, события и хуки
  BaseWidget, а опечатка в имени метода видна до установки. Сами типы ничего не
  исполняют: в оверлее `window.OSE` уже есть.

  Манифесты описаны ниже (`WidgetManifest`, `ThemeManifest`) и в JSON-схемах
  `sdk/schema/`; проверка файлов — `sdk/validate.mjs`.
*/

declare namespace Ose {
  type SettingType = "string" | "text" | "number" | "range" | "color" | "boolean" | "select";

  interface SettingOption {
    value: string;
    label?: string;
  }

  interface SettingField {
    type: SettingType;
    label?: string;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    options?: Array<string | SettingOption>;
  }

  type SettingsSchema = Record<string, SettingField>;
  type Config = Record<string, unknown>;

  interface Geometry {
    x: number;
    y: number;
    w: number;
    h: number;
    z: number;
    visible: boolean;
  }

  interface Alert {
    kind: "follow" | "sub" | "gift_sub" | "cheer" | "donation" | "reward" | string;
    user: string;
    amount?: number;
    currency?: string;
    message?: string;
    tier?: string;
    count?: number;
    months?: number;
    isTest?: boolean;
    [key: string]: unknown;
  }

  interface ChatMessage {
    user: string;
    message: string;
    color?: string;
    badges?: string[];
    isTest?: boolean;
    [key: string]: unknown;
  }

  /** Полезные события шины с разобранной нагрузкой. Остальные — `unknown`. */
  interface EventMap {
    alert: Alert;
    chat_message: ChatMessage;
    recent_event: Record<string, unknown>;
    goal_update: { current: number; target: number; title?: string; currency?: string };
    stat_update: { followerCount: number | null; subscriberCount: number | null };
    theme_update: {
      activeThemeId: string;
      enable3d: boolean;
      activeThemeId3d?: string;
      tokens: Record<string, string>;
    };
    session_stats: { count: number; amount: number; currency: string };
    ticker_message: { text: string; priority: "normal" | "breaking"; durationMs?: number };
    music_play: { musicLink: string; musicTitle?: string; user?: string; silent?: boolean };
    music_control: { action: "skip" | "stop" };
    top_donation_update: { user: string; amount: number; currency: string };
    death_count_update: { count: number };
    reward_redeem: { user: string; rewardTitle: string; message?: string };
  }

  /**
   * Константы событий: `OSE.EVENT_TYPES.ALERT` — это `"alert"`, тот же ключ,
   * что в `EventMap`. Полный список — в `shared/events.js`.
   */
  interface EventTypes {
    STATE: "state";
    ALERT: "alert";
    CHAT_MESSAGE: "chat_message";
    RECENT_EVENT: "recent_event";
    GOAL_UPDATE: "goal_update";
    STAT_UPDATE: "stat_update";
    THEME_UPDATE: "theme_update";
    SESSION_STATS: "session_stats";
    TICKER_MESSAGE: "ticker_message";
    MUSIC_PLAY: "music_play";
    MUSIC_CONTROL: "music_control";
    TOP_DONATION_UPDATE: "top_donation_update";
    DEATH_COUNT_UPDATE: "death_count_update";
    REWARD_REDEEM: "reward_redeem";
    [key: string]: string;
  }

  interface Subscription {
    channel: string;
    handler: (payload: unknown) => void;
    off: (() => void) | null;
  }

  interface WidgetContext {
    bus?: { on(channel: string, handler: (payload: unknown) => void): () => void };
    readCssVar?: (name: string) => string;
    t?: (key: string, params?: Record<string, unknown>) => string;
    escapeHtml?: (text: string) => string;
    escapeAttr?: (text: string) => string;
    formatMoney?: (value: number) => string;
    currencySymbol?: (code: string) => string;
    resolveMediaUrl?: (path: string) => string;
    ICONS?: Record<string, string>;
    [key: string]: unknown;
  }

  interface WidgetConfig<TConfig extends Config = Config> {
    id?: string;
    type?: string;
    renderType?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    z?: number;
    visible?: boolean;
    config?: TConfig;
  }

  /**
   * База виджетов оверлея. Наследуйтесь от `OSE.BaseWidget` и переопределяйте
   * `render`, `onMount`, `onUpdate`, `onUnmount` — движок сам создаёт элемент,
   * выставляет геометрию и снимает подписки при удалении.
   */
  class BaseWidget<TConfig extends Config = Config> {
    static AMBIENT_FPS: number;
    static clockTime(date?: Date): string;

    constructor(config?: WidgetConfig<TConfig>, context?: WidgetContext);

    id: string | null;
    type: string;
    renderType: "2d" | "canvas" | "3d-webgl";
    config: TConfig;
    geometry: Geometry;
    element: HTMLElement | HTMLCanvasElement | null;
    canvas: HTMLCanvasElement | null;
    ctx: CanvasRenderingContext2D | null;
    gl: WebGLRenderingContext | null;
    context: WidgetContext;

    mount(parentEl: HTMLElement): HTMLElement | HTMLCanvasElement;
    update(newConfig?: Partial<WidgetConfig<TConfig>>): void;
    unmount(): void;

    startRenderLoop(fps?: number): void;
    stopRenderLoop(): void;
    setIdle(idle: boolean): void;

    later(fn: () => void, ms?: number): number;
    every(fn: () => void, ms: number): number;
    clearTimer(id: number): void;
    on(target: EventTarget, type: string, fn: EventListener, options?: AddEventListenerOptions | boolean): void;

    subscribe<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): Subscription | null;
    subscribe(event: string, handler: (payload: unknown) => void): Subscription | null;

    resize(): void;

    onMount(): void;
    onUpdate(prevConfig: TConfig, nextConfig: TConfig): void;
    onUnmount(): void;
    onIdle(idle: boolean): void;
    render(): void;
  }

  interface PluginWidget {
    kind: "widget";
    id: string;
    type: string;
    name: string;
    description?: string;
    version?: string;
    author?: string;
    baseUrl: string;
    entry: string;
    styles: string[];
    icon: string;
    geometry: Partial<Geometry>;
    minW?: number;
    minH?: number;
    settings: SettingsSchema;
  }

  interface PluginTheme {
    kind: "theme";
    id: string;
    pluginId: string;
    name: string;
    version?: string;
    author?: string;
    baseUrl: string;
    css?: string | null;
    tokens: Record<string, string>;
    colors: Array<string | null>;
  }

  /** Публичное API — то, что лежит в `window.OSE`. */
  interface Api {
    readonly version: number;
    readonly ready: Promise<Api> | null;
    readonly plugins: Array<PluginWidget | PluginTheme>;
    readonly errors: Array<{ dir: string; error: string }>;
    readonly themes: Record<string, unknown>;
    readonly widgets: Record<string, typeof BaseWidget>;

    BaseWidget: typeof BaseWidget;
    EVENT_TYPES: EventTypes;

    defineWidget<TConfig extends Config = Config>(
      id: string,
      WidgetClass: new (config?: WidgetConfig<TConfig>, context?: WidgetContext) => BaseWidget<TConfig>
    ): void;
    onWidget(listener: (type: string, WidgetClass: typeof BaseWidget) => void): () => void;

    asset(pluginId: string, path: string): string;
    cssVar(name: string): string;
    t(key: string, params?: Record<string, unknown>): string;
    load(options?: { widgets?: boolean }): Promise<Api>;
  }

  interface PluginBase {
    $schema?: string;
    apiVersion: 1;
    id: string;
    name: string;
    description?: string;
    version?: string;
    author?: string;
  }

  interface WidgetManifest extends PluginBase {
    kind: "widget";
    entry: string;
    styles?: string[];
    icon?: string;
    defaultGeometry?: Partial<Pick<Geometry, "x" | "y" | "w" | "h">>;
    minW?: number;
    minH?: number;
    settings?: SettingsSchema;
  }

  interface ThemeManifest extends PluginBase {
    kind: "theme";
    tokens: Record<`--${string}`, string>;
    css?: string;
  }
}

interface Window {
  OSE: Ose.Api;
}
