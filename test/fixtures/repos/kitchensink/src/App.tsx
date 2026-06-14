// traps: M10 (bare side-effect import of @/styles/base.scss) · S8 (bare global .css
// side-effect) · T2 (formatLabel call site) · T3 (Registry instantiation) · T8 (JSX render
// tree — the find_usages JSX blast radius for every feature component). The app root that
// makes the whole graph reachable.
import '@/styles/base.scss';
import '@/styles/theme.css';
import { formatLabel } from '@/core/format.ts';
import { Registry } from '@/core/registry.ts';
import { Widget } from '@/features/widget/Widget.tsx';
import { Dashboard } from '@/features/dashboard/Dashboard.tsx';
import { Panel } from '@/features/panel/Panel.tsx';
import { Table } from '@/features/table/Table.tsx';
import { Form } from '@/features/forms/Form.tsx';
import { Showcase } from '@/features/misc/Showcase.tsx';
import { lazyRegistry } from '@/features/forms/lazy.ts';

const appRegistry = new Registry<string>('app'); // T3 instantiation
appRegistry.register('title', formatLabel('App')); // T2 call site

export function App(): JSX.Element {
  const Lazy = lazyRegistry.widget;
  return (
    <main>
      <h1>{formatLabel('Kitchensink', true)}</h1>
      <Widget label="w" active />
      <Dashboard />
      <Panel />
      <Table variant="a" tone="b" />
      <Form status="ready" />
      <Showcase label="show case" />
      <Lazy label="lazy" />
    </main>
  );
}
