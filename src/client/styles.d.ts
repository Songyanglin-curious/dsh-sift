declare module '*.css?inline' { const css: string; export default css; }
declare module '*?raw' { const content: string; export default content; }

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react';
  interface ModalProps {
    open: boolean;
    onClose: () => void;
    title: string;
    closeLabel?: string;
    description?: string;
    footer?: ReactNode;
    children?: ReactNode;
  }
  export const Modal: ComponentType<ModalProps>;
}
