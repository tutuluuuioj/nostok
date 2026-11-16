declare module 'react' {
  export function createElement(type: any, props?: any, ...children: any[]): any;
  export function useState<T = any>(initial?: T | (() => T)): [T, (next: any) => void];
  export function useEffect(fn: () => void | (() => void), deps?: readonly any[]): void;
  export function useLayoutEffect(fn: () => void | (() => void), deps?: readonly any[]): void;
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly any[]): T;
  export function useMemo<T>(fn: () => T, deps: readonly any[]): T;
  export function useRef<T = any>(initial?: T): { current: T };
  export function createContext<T = any>(defaultValue: T): any;
  export function useContext<T = any>(ctx: any): T;
  export class Component<P = any, S = any> {
    props: P;
    state: S;
    constructor(props: P);
  }
}

declare module 'react/jsx-runtime' {
  export function jsx(type: any, props: any, key?: any): any;
  export function jsxs(type: any, props: any, key?: any): any;
  export const Fragment: any;
}

declare module 'react-dom/server' {
  export function renderToStaticMarkup(element: any): string;
}
