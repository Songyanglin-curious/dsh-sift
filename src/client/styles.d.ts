declare module '*.css?inline' { const css: string; export default css; }
declare module '*?raw' { const content: string; export default content; }

/**
 * DSH client primitives 的最小类型声明。
 *
 * 这些类型对应运行时真实实现（dsh-web-frontend 内的 primitives 导出），
 * 只声明本插件用到的部分：
 * - Modal：open/onClose/title/closeLabel/description/footer/children
 *          + className（作用于 dialog 本体，用于覆盖默认 width）
 *          + contentClassName（作用于内容区）
 * - Button：variant(primary|ghost|outline|toolbar) + size(md|sm) + icon
 * - Input：原生 input 属性 + 前置 icon
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, InputHTMLAttributes, ReactNode } from 'react';

  interface ModalProps {
    open: boolean;
    onClose: () => void;
    title: string;
    closeLabel?: string;
    description?: string;
    footer?: ReactNode;
    children?: ReactNode;
    /** 追加到 dialog 本体（默认 `width: min(380px, 100%)`）。 */
    className?: string;
    /** 追加到内容区。 */
    contentClassName?: string;
    headless?: boolean;
  }

  interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar';
    size?: 'md' | 'sm';
    icon?: ReactNode;
  }

  interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    icon?: ReactNode;
  }

  interface PillProps {
    active?: boolean;
    className?: string;
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }

  interface MarkdownTextProps {
    text: string;
    streaming?: boolean;
    className?: string;
    labels: {
      code: {
        copyLabel: string;
        copiedLabel: string;
      };
      footnotes: string;
    };
  }

  export const Modal: ComponentType<ModalProps>;
  export const Button: ComponentType<ButtonProps>;
  export const Input: ComponentType<InputProps>;
  export const Pill: ComponentType<PillProps>;
  export const MarkdownText: ComponentType<MarkdownTextProps>;
}
