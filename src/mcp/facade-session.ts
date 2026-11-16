// One MCP connection's memory of what it already told the agent (§11/§12): folded prose, the build
// line, and the `status` catalogue it listed. Off by default in `serveMcp`; the composition root
// turns it on. Every response opens a scope; the scope commits against the final, capped text.

import { CONCEPT_LESSONS } from '../format/render/concepts.ts';
import type { ProseFold } from '../format/render/fold-prose.ts';
import {
  catalogueLines,
  renderCatalogue,
  type StatusRecall,
} from '../format/render/render-status-recall.ts';
import type { StatusView } from '../format/render/render-status.ts';
import { LESSONS } from './lessons.ts';
import { createSessionMemory, noFolding, type ResponseFolder } from './session-memory.ts';

export interface ResponseScope extends ResponseFolder {
  /** The one-line build stamp for a text response: once per session, again whenever the build
   *  changes (an `@unknown` stamp is followed by the real one as soon as it is known). */
  buildLine(build: string | undefined): string;
  /** What a `status` render may treat as already seen; undefined outside a session. */
  statusRecall(): StatusRecall | undefined;
  /** Record a `status` view's catalogue as delivered when its lines survived in `finalText`. */
  noteStatus(view: StatusView): void;
}

export interface FacadeSession {
  begin(): ResponseScope;
}

export const noSession: FacadeSession = {
  begin: () => ({
    ...noFolding,
    buildLine: () => '',
    statusRecall: () => undefined,
    noteStatus: () => undefined,
  }),
};

export function createFacadeSession(): FacadeSession {
  const memory = createSessionMemory(LESSONS);
  const catalogues = new Map<string, readonly string[]>();
  let latest: { root: string; lines: readonly string[] } | undefined;
  let stampedBuild: string | undefined;
  return {
    begin() {
      const folder = memory.beginResponse();
      let pendingStatus: { root: string; lines: readonly string[]; rendered: string } | undefined;
      const statusRecall = (): StatusRecall => ({
        catalogue: (root) => {
          const lines = catalogues.get(root);
          return lines !== undefined ? { root, lines } : latest;
        },
        conceptsShown: CONCEPT_LESSONS.every((c) => memory.isShown(c)),
      });
      return {
        foldFor: (root): ProseFold => folder.foldFor(root),
        repair: (text) => folder.repair(text),
        commit(finalText) {
          folder.commit(finalText);
          // The catalogue block as rendered (full list, or the diff against what was shown) must
          // have survived whole — a diff cut after its header would otherwise hide its changes.
          const p = pendingStatus;
          if (p !== undefined && finalText.includes(p.rendered)) {
            catalogues.set(p.root, p.lines);
            latest = p;
          }
        },
        buildLine(build) {
          if (build === undefined || build === stampedBuild) return '';
          stampedBuild = build;
          return `codemaster v${build}\n`;
        },
        statusRecall,
        noteStatus(view) {
          const ws = view.workspace;
          if (ws === undefined || ws.ops.length === 0) return;
          const rendered = renderCatalogue(ws, statusRecall()).join('\n');
          pendingStatus = { root: ws.root, lines: catalogueLines(ws), rendered };
        },
      };
    },
  };
}
