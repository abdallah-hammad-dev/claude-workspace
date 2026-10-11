/**
 * Browser stand-in for the `obsidian` module, for UI previews only.
 * Reproduces Obsidian's DOM helpers and the markup of Setting / Menu so that
 * Obsidian's real app.css styles our views the same way it does in the app.
 */
import { createElement, icons } from "lucide";
import { marked } from "marked";

type DomInfo = {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  type?: string;
  value?: string;
  placeholder?: string;
  title?: string;
  href?: string;
};

function applyInfo(el: HTMLElement, o?: DomInfo | string): void {
  if (!o) return;
  if (typeof o === "string") {
    el.className = o;
    return;
  }
  if (o.cls) el.classList.add(...(Array.isArray(o.cls) ? o.cls : o.cls.split(" ")).filter(Boolean));
  if (o.text !== undefined) {
    if (typeof o.text === "string") el.textContent = o.text;
    else el.appendChild(o.text);
  }
  for (const [k, v] of Object.entries(o.attr ?? {})) if (v !== null && v !== false) el.setAttribute(k, String(v));
  if (o.type) el.setAttribute("type", o.type);
  if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
  if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
  if (o.title) el.setAttribute("title", o.title);
  if (o.href) el.setAttribute("href", o.href);
}

function createEl(this: Node, tag: string, o?: DomInfo | string, cb?: (el: HTMLElement) => void): HTMLElement {
  const el = document.createElement(tag);
  applyInfo(el, o);
  this.appendChild(el);
  cb?.(el);
  return el;
}

const nodeProto = Node.prototype as unknown as Record<string, unknown>;
nodeProto.createEl = createEl;
nodeProto.createDiv = function (this: Node, o?: DomInfo | string) {
  return createEl.call(this, "div", o);
};
nodeProto.createSpan = function (this: Node, o?: DomInfo | string) {
  return createEl.call(this, "span", o);
};
nodeProto.empty = function (this: Node) {
  while (this.firstChild) this.removeChild(this.firstChild);
};
nodeProto.appendText = function (this: Node, t: string) {
  this.appendChild(document.createTextNode(t));
};
nodeProto.detach = function (this: Node) {
  this.parentNode?.removeChild(this);
};

const el = HTMLElement.prototype as unknown as Record<string, unknown>;
const elementProto = Element.prototype as unknown as Record<string, unknown>;
elementProto.setText = function (this: Element, t: string | DocumentFragment) {
  (this as unknown as { empty(): void }).empty();
  if (typeof t === "string") this.textContent = t;
  else this.appendChild(t);
};
elementProto.getText = function (this: Element) {
  return this.textContent ?? "";
};
elementProto.addClass = function (this: Element, ...c: string[]) {
  this.classList.add(...c.flatMap((x) => x.split(" ")).filter(Boolean));
};
elementProto.addClasses = function (this: Element, c: string[]) {
  this.classList.add(...c);
};
elementProto.removeClass = function (this: Element, ...c: string[]) {
  this.classList.remove(...c);
};
elementProto.toggleClass = function (this: Element, c: string | string[], v: boolean) {
  for (const x of Array.isArray(c) ? c : [c]) this.classList.toggle(x, v);
};
elementProto.hasClass = function (this: Element, c: string) {
  return this.classList.contains(c);
};
elementProto.setAttr = function (this: Element, k: string, v: string | number | boolean | null) {
  if (v === null || v === false) this.removeAttribute(k);
  else this.setAttribute(k, String(v));
};
el.show = function (this: HTMLElement) {
  this.style.display = "";
};
el.hide = function (this: HTMLElement) {
  this.style.display = "none";
};
el.toggle = function (this: HTMLElement, v: boolean) {
  this.style.display = v ? "" : "none";
};
el.isShown = function (this: HTMLElement) {
  return this.style.display !== "none" && this.isConnected;
};
el.onClickEvent = function (this: HTMLElement, cb: (e: MouseEvent) => void) {
  this.addEventListener("click", cb);
};
const fragProto = DocumentFragment.prototype as unknown as Record<string, unknown>;
fragProto.createEl = createEl;

const g = window as unknown as Record<string, unknown>;
g.createFragment = (cb?: (f: DocumentFragment) => void) => {
  const f = document.createDocumentFragment();
  cb?.(f);
  return f;
};
g.activeWindow = window;
g.activeDocument = document;

// ───────────────────────── icons, tooltips, markdown ─────────────────────────

const pascal = (n: string) => n.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

export function setIcon(parent: HTMLElement, name: string): void {
  (parent as unknown as { empty(): void }).empty();
  const node = (icons as Record<string, unknown>)[pascal(name)];
  const svg = node
    ? (createElement(node as Parameters<typeof createElement>[0]) as unknown as SVGElement)
    : (createElement(icons.CircleHelp) as unknown as SVGElement);
  svg.setAttribute("class", `svg-icon lucide-${name}`);
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  if (!node) svg.style.color = "red"; // missing icon: make it obvious in screenshots
  parent.appendChild(svg);
}

export function setTooltip(target: HTMLElement, text: string): void {
  target.setAttribute("aria-label", text);
}

export const MarkdownRenderer = {
  render(_app: unknown, md: string, target: HTMLElement): Promise<void> {
    target.innerHTML = marked.parse(md, { async: false });
    return Promise.resolve();
  },
};

// ───────────────────────── basics ─────────────────────────

export const Platform = { isDesktopApp: true, isMobile: false };
export const Keymap = { isModEvent: () => false };
export function debounce<T extends (...a: unknown[]) => unknown>(fn: T): T {
  return fn;
}
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export class Notice {
  noticeEl = document.createElement("div");
  constructor(message: string) {
    console.log("[Notice]", message);
  }
}

export class TFile {
  constructor(public path: string) {}
  get name(): string {
    return this.path.split("/").pop() ?? this.path;
  }
}

export class Component {
  load(): void {}
  unload(): void {}
  register(): void {}
  registerEvent(): void {}
  registerDomEvent(): void {}
  addChild<T>(c: T): T {
    return c;
  }
}

export class View extends Component {
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  app: unknown;
  constructor(public leaf: { app: unknown }) {
    super();
    this.app = leaf.app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content";
    this.contentEl = (this.containerEl as unknown as { createDiv(o: string): HTMLElement }).createDiv("view-content");
  }
  getState(): Record<string, unknown> {
    return {};
  }
  async setState(): Promise<void> {}
}
export class ItemView extends View {}

export class Modal extends Component {
  constructor(public app: unknown) {
    super();
  }
  open(): void {}
  close(): void {}
}
export class SuggestModal<T> extends Modal {
  setPlaceholder(_p: string): void {}
  declare _t: T;
}

// ───────────────────────── Menu (real markup) ─────────────────────────

class MenuItem {
  dom: HTMLElement;
  private iconEl: HTMLElement;
  private titleEl: HTMLElement;
  private click: (() => void) | null = null;
  constructor(menu: HTMLElement) {
    this.dom = (menu as unknown as { createDiv(o: string): HTMLElement }).createDiv("menu-item tappable");
    this.iconEl = (this.dom as unknown as { createDiv(o: string): HTMLElement }).createDiv("menu-item-icon");
    this.titleEl = (this.dom as unknown as { createDiv(o: string): HTMLElement }).createDiv("menu-item-title");
    this.dom.addEventListener("click", () => this.click?.());
  }
  setTitle(t: string | DocumentFragment): this {
    (this.titleEl as unknown as { setText(t: string | DocumentFragment): void }).setText(t);
    return this;
  }
  setIcon(name: string | null): this {
    if (name) setIcon(this.iconEl, name);
    return this;
  }
  setChecked(c: boolean | null): this {
    if (c) {
      const check = (this.dom as unknown as { createDiv(o: string): HTMLElement }).createDiv("menu-item-icon mod-checked");
      setIcon(check, "check");
      this.dom.classList.add("mod-checked");
    }
    return this;
  }
  setSection(): this {
    return this;
  }
  setDisabled(): this {
    return this;
  }
  setWarning(w: boolean): this {
    this.dom.classList.toggle("mod-warning", w);
    return this;
  }
  onClick(cb: () => void): this {
    this.click = cb;
    return this;
  }
}

export class Menu extends Component {
  private dom = document.createElement("div");
  constructor() {
    super();
    this.dom.className = "menu";
    const scroll = document.createElement("div");
    scroll.className = "menu-scroll";
    this.dom.appendChild(scroll);
  }
  addItem(cb: (item: MenuItem) => void): this {
    cb(new MenuItem(this.dom.firstElementChild as HTMLElement));
    return this;
  }
  addSeparator(): this {
    (this.dom.firstElementChild as unknown as { createDiv(o: string): HTMLElement }).createDiv("menu-separator");
    return this;
  }
  showAtPosition(pos: { x: number; y: number }): this {
    document.body.appendChild(this.dom);
    const h = this.dom.offsetHeight;
    this.dom.style.left = `${pos.x}px`;
    this.dom.style.top = `${Math.max(8, pos.y - h - 4)}px`;
    return this;
  }
  showAtMouseEvent(e: MouseEvent): this {
    return this.showAtPosition({ x: e.clientX, y: e.clientY });
  }
}

// ───────────────────────── Setting (real markup) ─────────────────────────

abstract class ValueComponent<T> {
  protected cb: ((v: T) => unknown) | null = null;
  onChange(cb: (v: T) => unknown): this {
    this.cb = cb;
    return this;
  }
}

class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement;
  private value = false;
  constructor(parent: HTMLElement) {
    super();
    this.toggleEl = (parent as unknown as { createDiv(o: string): HTMLElement }).createDiv("checkbox-container");
    this.toggleEl.appendChild(Object.assign(document.createElement("input"), { type: "checkbox", tabIndex: 0 }));
    this.toggleEl.addEventListener("click", () => {
      this.setValue(!this.value);
      void this.cb?.(this.value);
    });
  }
  setValue(v: boolean): this {
    this.value = v;
    this.toggleEl.classList.toggle("is-enabled", v);
    return this;
  }
  setDisabled(d: boolean): this {
    this.toggleEl.classList.toggle("is-disabled", d);
    return this;
  }
}

class TextComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement | HTMLTextAreaElement;
  constructor(parent: HTMLElement, tag: "input" | "textarea") {
    super();
    this.inputEl = document.createElement(tag);
    if (tag === "input") this.inputEl.setAttribute("type", "text");
    parent.appendChild(this.inputEl);
    this.inputEl.addEventListener("input", () => void this.cb?.(this.inputEl.value));
  }
  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
  setValue(v: string): this {
    this.inputEl.value = v;
    return this;
  }
}

class ButtonComponent {
  buttonEl: HTMLButtonElement;
  constructor(parent: HTMLElement) {
    this.buttonEl = document.createElement("button");
    parent.appendChild(this.buttonEl);
  }
  setButtonText(t: string): this {
    this.buttonEl.textContent = t;
    return this;
  }
  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  onClick(cb: () => unknown): this {
    this.buttonEl.addEventListener("click", () => void cb());
    return this;
  }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  constructor(container: HTMLElement) {
    const c = (p: HTMLElement, cls: string) => (p as unknown as { createDiv(o: string): HTMLElement }).createDiv(cls);
    this.settingEl = c(container, "setting-item");
    this.infoEl = c(this.settingEl, "setting-item-info");
    this.nameEl = c(this.infoEl, "setting-item-name");
    this.descEl = c(this.infoEl, "setting-item-description");
    this.controlEl = c(this.settingEl, "setting-item-control");
  }
  setName(n: string | DocumentFragment): this {
    (this.nameEl as unknown as { setText(t: string | DocumentFragment): void }).setText(n);
    return this;
  }
  setDesc(d: string | DocumentFragment): this {
    (this.descEl as unknown as { setText(t: string | DocumentFragment): void }).setText(d);
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  addToggle(cb: (t: ToggleComponent) => unknown): this {
    cb(new ToggleComponent(this.controlEl));
    return this;
  }
  addText(cb: (t: TextComponent) => unknown): this {
    cb(new TextComponent(this.controlEl, "input"));
    return this;
  }
  addTextArea(cb: (t: TextComponent) => unknown): this {
    cb(new TextComponent(this.controlEl, "textarea"));
    return this;
  }
  addButton(cb: (b: ButtonComponent) => unknown): this {
    cb(new ButtonComponent(this.controlEl));
    return this;
  }
}

export class PluginSettingTab {
  containerEl = document.createElement("div");
  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {
    this.containerEl.className = "vertical-tab-content";
  }
}

export class Plugin extends Component {}
export class WorkspaceLeaf {}
export class MarkdownView {}
export class FileView {}
