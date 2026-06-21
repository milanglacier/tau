type SpeechRecognitionConstructor = new () => EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
};

interface Window {
  copyCode?: (button: HTMLElement) => void;
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

interface Element {
  dataset: DOMStringMap;
  disabled: boolean;
  files: FileList | null;
  focus(options?: FocusOptions): void;
  isContentEditable: boolean;
  onclick: ((this: GlobalEventHandlers, ev: MouseEvent) => unknown) | null;
  placeholder: string;
  select(): void;
  selectionEnd: number | null;
  selectionStart: number | null;
  setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void;
  style: CSSStyleDeclaration;
  value: string;
}
