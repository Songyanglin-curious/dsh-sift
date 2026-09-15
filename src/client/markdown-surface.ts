import type { Crepe } from '@milkdown/crepe';

/** Shared Markdown surface for output editing and read-only material previews. */
export async function createMarkdownSurface(root: HTMLElement, markdown: string, options: { readonly?: boolean; onChange?: () => void } = {}): Promise<Crepe> {
  const { Crepe } = await import('@milkdown/crepe');
  const editor = new Crepe({ root, defaultValue: markdown,
    features: { [Crepe.Feature.Latex]: false },
    featureConfigs: { [Crepe.Feature.Placeholder]: { text: '开始写作，或粘贴 Markdown…' } },
  });
  if (options.readonly) editor.setReadonly(true);
  if (options.onChange) editor.on(listener => listener.markdownUpdated(options.onChange!));
  try { await editor.create(); return editor; }
  catch (error) { await editor.destroy().catch(() => {}); throw error; }
}
