// traps: S3 (≥3 CSS modules into one .tsx, per-binding resolution) · S4 (missing/NO-RULE
// direction: `grid.missingCol` and `theme.missingTone` are referenced with no scss rule) ·
// M4 (imports formatLabel via the DEEP 3-hop path @/shared/chain/a.ts — others use the hub /
// the decl) · T13 (references the const-enum member Code.Ok, inlined) · T2 (formatLabel) ·
// S12 (uses `grid.composeConsumer`, the isolable composes consumer) · i18n (t() static + a
// missing key via Panel/forms).
import { formatLabel } from '@/shared/chain/a.ts';
import { t } from '@/core/i18n.ts';
import { Code } from '@/core/codes.ts';
import { Registry } from '@/core/registry.ts';
import grid from './grid.module.scss';
import theme from './theme.module.scss';
import zoo from './zoo.module.scss';

// T3 — Registry instance; method called via DESTRUCTURE (not via the instance).
const dashRegistry = new Registry<string>('dashboard');
const { register } = dashRegistry;
register('init', 'ok');

export function Dashboard(props: { section?: string }): JSX.Element {
  const ok = Code.Ok; // const-enum member ref (inlined) — T13
  // I2 dynamic key — template literal → flagged `dynamic`, never resolved/guessed.
  const dynamicLabel = t(`dashboard.${props.section ?? 'heading'}`);
  // I2 used-but-undeclared — `absent.key` is in no locale → find_missing_i18n_keys flags it.
  const absent = t('absent.key');
  return (
    <section className={grid.container} title={`${dynamicLabel} ${absent}`}>
      <h1 className={zoo.heading}>{formatLabel(t('dashboard.heading'), true)}</h1>
      <div className={`${theme.dark} ${grid.cell}`}>
        {/* S4 missing: no `.missingCol` rule in grid.module.scss */}
        <span className={grid.missingCol}>{t('dashboard.empty')}</span>
        {/* S4 missing: no `.missingTone` rule in theme.module.scss */}
        <span className={theme.missingTone}>{ok}</span>
      </div>
      <p className={`${theme.light} ${zoo.empty}`} />
      {/* S12 — uses composeConsumer (which `composes: composeBase`); composeBase is reachable
          ONLY through that composition, never referenced directly. */}
      <footer className={grid.composeConsumer} />
    </section>
  );
}
