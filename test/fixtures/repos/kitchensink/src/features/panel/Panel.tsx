// traps: S6 (*.module.css module — usage detected, classes not scss-parsed) · M8 (import
// cycle Panel ↔ Table: Panel imports `rowCount` from Table, Table imports `panelTitle` from
// Panel — must not hang/lie) · T2 (formatLabel) · i18n (t('panel.label')). The const-enum
// import lives in dashboard/forms.
import { formatLabel } from '@/core/format.ts';
import { t } from '@/core/i18n.ts';
import { rowCount } from '@/features/table/Table.tsx';
import css from './panel.module.css';

/** exported back into the cycle — Table imports this. */
export function panelTitle(): string {
  return formatLabel(t('panel.label'));
}

export function Panel(): JSX.Element {
  return (
    <aside className={css.panelBox}>
      <h2 className={css.panelHead}>{panelTitle()}</h2>
      <span>{rowCount()}</span>
    </aside>
  );
}
