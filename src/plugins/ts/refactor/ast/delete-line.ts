// A single span-edit builder shared by the import normalizers: delete a whole statement's line,
// including its trailing newline, so removing a declaration leaves no blank line behind. Indent-safe
// — the start is the line's first column (`lastIndexOf('\n') + 1`), not the node's start.

import type ts from 'typescript';
import type { TextEdit } from '../../../../support/text-edits/apply.ts';

export function deleteWholeLine(content: string, sf: ts.SourceFile, node: ts.Node): TextEdit {
  const start = content.lastIndexOf('\n', node.getStart(sf) - 1) + 1;
  let end = node.getEnd();
  if (content[end] === '\n') end += 1;
  return { start, end, text: '' };
}
