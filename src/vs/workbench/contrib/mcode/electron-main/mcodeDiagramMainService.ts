/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as pathLib from 'path';
import { IVoidDiagramService, IManimRenderResult } from '../common/mcodeDiagramTypes.js';

const exec = promisify(_exec);

export class VoidDiagramService implements IVoidDiagramService {
	readonly _serviceBrand: undefined;

	async renderManim(code: string, cwd: string): Promise<IManimRenderResult> {
		const tempFileName = 'temp_manim_scene.py';
		const tempFilePath = pathLib.join(cwd, tempFileName);

		try {
			await fs.writeFile(tempFilePath, code, 'utf8');

			// Execute manim to render the scene (-ql means low quality)
			const { stdout, stderr } = await exec(`manim -ql "${tempFileName}"`, { cwd, timeout: 60000 });

			// Search default output directory first
			const searchDir = pathLib.join(cwd, 'media', 'videos', 'temp_manim_scene', '480p15');
			try {
				const files = await fs.readdir(searchDir);
				const mp4File = files.find(f => f.toLowerCase().endsWith('.mp4'));
				if (mp4File) {
					const fullPath = pathLib.join(searchDir, mp4File);
					return { success: true, mediaPath: fullPath };
				}
			} catch (dirErr) {
				// standard folder does not exist, look elsewhere
			}

			// Try to extract path from log output
			const outputMatch = stdout.match(/File ready at\s+'([^']+)'/i) || stderr.match(/File ready at\s+'([^']+)'/i);
			if (outputMatch && outputMatch[1]) {
				const fullPath = pathLib.resolve(cwd, outputMatch[1].trim());
				return { success: true, mediaPath: fullPath };
			}

			// Search recursively under media/ folder for the newest mp4
			const mediaDir = pathLib.join(cwd, 'media');
			const newestMp4 = await findNewestMp4(mediaDir);
			if (newestMp4) {
				return { success: true, mediaPath: newestMp4 };
			}

			return {
				success: false,
				error: `Manim run completed, but couldn't locate the output video file. Output:\n${stdout}\n${stderr}`
			};

		} catch (err: any) {
			return {
				success: false,
				error: err.stderr || err.stdout || err.message || 'Unknown Manim compilation error.'
			};
		} finally {
			try {
				await fs.unlink(tempFilePath);
			} catch (e) {}
		}
	}
}

async function findNewestMp4(dir: string): Promise<string | null> {
	try {
		const files = await fs.readdir(dir, { withFileTypes: true });
		let newestFile: string | null = null;
		let newestMtime = 0;

		for (const file of files) {
			const fullPath = pathLib.join(dir, file.name);
			if (file.isDirectory()) {
				const childNewest = await findNewestMp4(fullPath);
				if (childNewest) {
					const stat = await fs.stat(childNewest);
					if (stat.mtimeMs > newestMtime) {
						newestMtime = stat.mtimeMs;
						newestFile = childNewest;
					}
				}
			} else if (file.isFile() && file.name.toLowerCase().endsWith('.mp4')) {
				const stat = await fs.stat(fullPath);
				if (stat.mtimeMs > newestMtime) {
					newestMtime = stat.mtimeMs;
					newestFile = fullPath;
				}
			}
		}
		return newestFile;
	} catch (e) {
		return null;
	}
}
