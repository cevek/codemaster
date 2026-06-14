// traps: M3 (import-with-rename used as `<Card/>` JSX AND `fmt()` call) · T8 (namespaced JSX
// `<UI.Button/>`, spread props `{...p}`, computed + literal props) · T6 (overloaded `coerce`,
// merged `box`/`box.of`) · T9 (consumes the move/delete anchors) · M6 (default import
// `Panelish`) · M11 (imports @/lib/util WITHOUT extension — spelling B) · T11 (imports the
// ambient `virtual:config` module) · T3 (Registry instantiation) · T2 (fmt = formatLabel).
import { Card } from '@/shared/index.ts';
import { formatLabel as fmt } from '@/core/format.ts';
import * as UI from '@/features/ui/widgets.tsx';
import Panelish from '@/features/ui/widgets.tsx';
import { coerce, box } from '@/core/overloads.ts';
import { Registry } from '@/core/registry.ts';
import { movableAnchor, deletableAnchor } from './anchors.ts';
import { slug } from '@/lib/util';
import { labels, version } from 'virtual:config';

const showcaseRegistry = new Registry<string>('showcase'); // T3 instantiation

export function Showcase(props: { label: string; active?: boolean }): JSX.Element {
  showcaseRegistry.register('v', version);
  const heading = fmt(coerce(42)); // M3 rename call + T6 overload (number→string)
  const tag = box.of(slug(props.label)).label; // T6 merged namespace + M11 spelling B
  const anchored = movableAnchor(deletableAnchor().length); // T9 consumers

  return (
    <div data-tag={tag} data-n={anchored}>
      <h3>{heading}</h3>
      {/* M3 — renamed component used as JSX */}
      <Card {...props} />
      {/* T8 — namespaced JSX + computed + literal props */}
      <UI.Button label={labels[props.label] ?? 'fallback'} />
      <UI.Icon name={slug(heading)} data-active={props.active === true} />
      <Panelish />
    </div>
  );
}
