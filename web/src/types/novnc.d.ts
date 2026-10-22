// Minimal typings for the parts of noVNC's RFB client Cloude uses (the package ships none).
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; credentials?: { password?: string }; wsProtocols?: string[] });
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    focus(): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
    sendCtrlAltDel(): void;
  }
}
