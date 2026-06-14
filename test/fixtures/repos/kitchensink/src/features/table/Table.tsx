// traps: M8 (import cycle — imports `panelTitle` from Panel, exports `rowCount` Panel
// imports) · S5 (s.row static · s['cell'] literal-computed · s[key] dynamic → partial ·
// s.ghost missing/NO-RULE) · S7 (legacy.sass bare side-effect, unsupported) · S13 (a:
// template-literal-prefix s[`variant-${v}`] → dynamic/partial; b: indirection map of static
// s.alpha/s.beta → counted used) · T5 (callback passing) · i18n (t('table.header')).
import { t } from '@/core/i18n.ts';
import { panelTitle } from '@/features/panel/Panel.tsx';
import s from './table.module.scss';
import './legacy.sass';

/** exported into the cycle — Panel imports this. */
export function rowCount(): number {
  return 0;
}

// S13(b): static indirection map — `s.alpha`/`s.beta` are real refs, must read as USED.
const TONE = { a: s.alpha, b: s.beta } as const;

export function Table(props: { variant: 'a' | 'b'; tone: 'a' | 'b' }): JSX.Element {
  const dynamicKey = `col-${props.variant}`;
  return (
    <table className={s.row}>
      <tbody>
        <tr className={s['cell']}>
          {/* S5 dynamic — which class is unprovable → partial */}
          <td className={s[dynamicKey]}>{panelTitle()}</td>
          {/* S13(a) template-literal prefix → dynamic/partial */}
          <td className={s[`variant-${props.variant}`]}>{t('table.header')}</td>
          {/* S13(b) static indirection map → alpha/beta used */}
          <td className={TONE[props.tone]} />
          {/* S12 — composes: `.composed` is used; `.cell` is used VIA composition */}
          <td className={s.composed} />
          {/* S5 missing — no `.ghost` rule in table.module.scss */}
          <td className={s.ghost} />
        </tr>
      </tbody>
    </table>
  );
}
