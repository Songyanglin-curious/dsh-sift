import type { ComponentType } from 'react';

interface SlotRegistration {
  name: 'conversation.input.right';
  id: 'sift-scaffold';
  order: number;
}

interface ClientContext {
  slots: {
    inject(name: SlotRegistration['name'], factory: () => () => void): unknown;
    register(options: SlotRegistration, component: ComponentType): () => void;
  };
}

function SiftScaffoldMarker() {
  return (
    <span
      data-dsh-sift-scaffold=""
      title="Sift 插件开发骨架已加载"
      style={{
        alignItems: 'center',
        border: '1px solid currentColor',
        borderRadius: '999px',
        display: 'inline-flex',
        fontSize: '12px',
        fontWeight: 600,
        height: '24px',
        lineHeight: 1,
        opacity: 0.72,
        padding: '0 8px',
      }}
    >
      Sift
    </span>
  );
}

export const inject = ['slots'];

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'sift-scaffold',
    order: 90,
  }, SiftScaffoldMarker));
}
