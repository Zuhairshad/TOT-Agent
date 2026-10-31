import { h, nextId } from './dom';

/** Editable list of short strings ("chips"): add with Enter/Add, remove with the x button. */
export interface ChipEditor {
  el: HTMLElement;
  values(): string[];
}

export function chipEditor(
  label: string,
  initial: string[],
  onChange?: (v: string[]) => void,
): ChipEditor {
  let values = [...initial];
  const inputId = nextId('chip');
  const list = h('ul', { class: 'chips editable', 'aria-label': label });
  const input = h('input', {
    id: inputId,
    type: 'text',
    placeholder: 'Add and press Enter',
    autocomplete: 'off',
  });
  const paint = () => {
    list.replaceChildren(
      ...values.map((v) =>
        h(
          'li',
          { class: 'chip' },
          v,
          h(
            'button',
            {
              type: 'button',
              class: 'chip-x',
              'aria-label': `Remove ${v}`,
              onclick: () => {
                values = values.filter((x) => x !== v);
                paint();
                onChange?.(values);
              },
            },
            '×',
          ),
        ),
      ),
    );
  };
  const add = () => {
    const v = input.value.trim();
    input.value = '';
    if (!v || values.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    values = [...values, v];
    paint();
    onChange?.(values);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });
  paint();
  const el = h(
    'div',
    { class: 'chip-editor' },
    h('label', { for: inputId }, label),
    list,
    h(
      'div',
      { class: 'chip-add' },
      input,
      h('button', { type: 'button', class: 'btn', onclick: add }, 'Add'),
    ),
  );
  return { el, values: () => [...values] };
}
