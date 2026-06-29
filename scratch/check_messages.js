const fs = require('fs');
const path = require('path');

const transcriptPath = 'C:\\Users\\lxs\\.gemini\\antigravity\\brain\\733b92a8-cb4e-426a-9789-97753b12f1cc\\.system_generated\\logs\\transcript.jsonl';

try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');
    console.log('Total steps in transcript:', lines.length);
    // Find the latest user input or planner response
    for (let i = lines.length - 1; i >= 0; i--) {
        const step = JSON.parse(lines[i]);
        if (step.type === 'PLANNER_RESPONSE') {
            console.log('Found PLANNER_RESPONSE at step:', step.step_index);
            // Print the tool calls or part of content
            console.log('Tool calls:', JSON.stringify(step.tool_calls, null, 2));
            break;
        }
    }
} catch (e) {
    console.error('Error:', e);
}
