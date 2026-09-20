import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  const { variant: _variant, ...buttonProps } = props;
  return <button {...buttonProps} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

export function Modal(props: {
  open: boolean;
  onClose(): void;
  title: string;
  description?: string;
  closeLabel?: string;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  if (!props.open) return null;
  return createPortal(<div role="dialog" aria-label={props.title} data-testid="sift-creator-modal">
    <h2>{props.title}</h2>
    {props.description && <p>{props.description}</p>}
    <div data-testid="modal-content">{props.children}</div>
    <div data-testid="footer">{props.footer}</div>
    <button data-testid="close-btn" onClick={props.onClose}>{props.closeLabel}</button>
  </div>, document.body);
}
