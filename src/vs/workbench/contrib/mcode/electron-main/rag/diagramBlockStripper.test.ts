/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { stripDiagramBlocksForLlm } from '../../common/helpers/diagramBlockStripper.js';

suite('diagramBlockStripper', () => {

	test('strips mermaid fenced blocks', () => {
		const input = `# SVG flow

Some prose.

\`\`\`mermaid
graph TD
  A --> B
  B --> C
\`\`\`

More text.`;
		const out = stripDiagramBlocksForLlm(input);
		assert.ok(!out.includes('graph TD'));
		assert.ok(out.includes('[mermaid diagram omitted'));
		assert.ok(out.includes('Some prose.'));
		assert.ok(out.includes('More text.'));
	});

	test('strips drawio and manim blocks', () => {
		const input = `\`\`\`drawio
<mxfile></mxfile>
\`\`\`
\`\`\`manim
class Scene(Scene):
    pass
\`\`\``;
		const out = stripDiagramBlocksForLlm(input);
		assert.ok(out.includes('[drawio diagram omitted'));
		assert.ok(out.includes('[manim diagram omitted'));
		assert.ok(!out.includes('mxfile'));
	});

	test('leaves other code fences unchanged', () => {
		const input = '```typescript\nconst x = 1;\n```';
		assert.strictEqual(stripDiagramBlocksForLlm(input), input);
	});

	test('returns input unchanged when no diagram blocks', () => {
		const input = 'plain markdown without fences';
		assert.strictEqual(stripDiagramBlocksForLlm(input), input);
	});
});
