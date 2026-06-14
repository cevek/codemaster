// traps: S1 (CSS module sibling) · S2 (bare side-effect import, no binding) · T2 (calls the
// high-fan-in formatLabel) · T8 (JSX: literal + computed props) · i18n (t() static). The
// `s['block__el']` access matches the BEM parent-ref concat class scss_classes synthesizes.
import { formatLabel } from '@/core/format.ts';
import { t } from '@/core/i18n.ts';
import s from './Widget.module.scss';
import './w.scss';

export function Widget(props: { label: string; active?: boolean }): JSX.Element {
  return (
    <div className={s.card} data-active={props.active}>
      <span className={s.title}>{formatLabel(t('widget.title'))}</span>
      <em className={s.badge}>{t('widget.subtitle')}</em>
      <i className={s['block__el']} />
      <p>{props.label}</p>
    </div>
  );
}
