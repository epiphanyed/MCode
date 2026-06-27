/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { URI } from '../../../../../../../base/common/uri.js';
import { StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';
import { RagRelatedDependency } from '../../../../common/mcodeRagTypes.js';
import { useAccessor } from '../util/services.js';
import { Link2, Plus } from 'lucide-react';

const KIND_LABEL: Record<RagRelatedDependency['kind'], string> = {
	imports: 'imports',
	imported_by: 'used by',
	calls: 'calls',
	references: 'references',
};

function displayPath(filePath: string, workspaceRoot: string | undefined): string {
	if (!workspaceRoot) {
		const parts = filePath.replace(/\\/g, '/').split('/');
		return parts.slice(-2).join('/');
	}
	const normalized = filePath.replace(/\\/g, '/');
	const root = workspaceRoot.replace(/\\/g, '/');
	if (normalized.startsWith(root)) {
		return normalized.slice(root.length).replace(/^\//, '');
	}
	return normalized.split('/').slice(-2).join('/');
}

export const DependencyRecommendations = ({
	selections,
	setSelections,
}: {
	selections: StagingSelectionItem[];
	setSelections: (s: StagingSelectionItem[]) => void;
}) => {
	const accessor = useAccessor();
	const contextGatheringService = accessor.get('IContextGatheringService');
	const modelService = accessor.get('IVoidModelService');
	const workspaceService = accessor.get('IWorkspaceContextService');
	const workspaceRoot = workspaceService.getWorkspace().folders[0]?.uri.fsPath;

	const [recommendations, setRecommendations] = useState<RagRelatedDependency[]>([]);
	const [loading, setLoading] = useState(false);

	const filePaths = selections
		.filter((s): s is StagingSelectionItem & { type: 'File' } => s.type === 'File')
		.map(s => s.uri.fsPath)
		.join('|');

	useEffect(() => {
		const fileSelections = selections.filter((s): s is StagingSelectionItem & { type: 'File' } => s.type === 'File');
		if (fileSelections.length === 0) {
			setRecommendations([]);
			return;
		}

		let cancelled = false;
		setLoading(true);

		(async () => {
			const merged: RagRelatedDependency[] = [];
			const seen = new Set<string>();
			const selectedPaths = new Set(fileSelections.map(s => s.uri.fsPath));

			for (const sel of fileSelections.slice(0, 3)) {
				try {
					const deps = await contextGatheringService.getRelatedDependencies(sel.uri, 6);
					for (const dep of deps) {
						if (seen.has(dep.filePath) || selectedPaths.has(dep.filePath)) {
							continue;
						}
						seen.add(dep.filePath);
						merged.push(dep);
					}
				} catch {
					// graph may be empty until index rebuild
				}
			}

			if (!cancelled) {
				setRecommendations(merged.slice(0, 5));
				setLoading(false);
			}
		})();

		return () => { cancelled = true; };
	}, [filePaths, contextGatheringService, selections]);

	if (loading && recommendations.length === 0) {
		return null;
	}
	if (recommendations.length === 0) {
		return null;
	}

	const addRecommendation = async (dep: RagRelatedDependency) => {
		const uri = URI.file(dep.filePath);
		const { model } = await modelService.getModelSafe(uri);
		const language = model?.getLanguageId() ?? 'plaintext';
		const newSelection: StagingSelectionItem = {
			type: 'File',
			uri,
			language,
			state: { wasAddedAsCurrentFile: false },
		};
		setSelections([...selections, newSelection]);
		setRecommendations(prev => prev.filter(r => r.filePath !== dep.filePath));
	};

	return (
		<div className='flex flex-col gap-1 pb-1 border-b border-void-border-3 mb-1'>
			<div className='flex items-center gap-1 text-xs text-void-fg-3 select-none'>
				<Link2 size={12} />
				<span>Related files</span>
			</div>
			<div className='flex flex-wrap gap-1'>
				{recommendations.map(rec => {
					const rel = displayPath(rec.filePath, workspaceRoot);
					return (
						<button
							key={rec.filePath}
							type='button'
							className='flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-sm border border-void-border-2 bg-void-bg-2 hover:bg-void-bg-3 text-void-fg-2 select-none'
							title={`${KIND_LABEL[rec.kind]}: ${rec.reason}`}
							onClick={() => addRecommendation(rec)}
						>
							<Plus size={11} />
							<span className='truncate max-w-[140px]'>{rel}</span>
							<span className='text-void-fg-4 text-[10px]'>{KIND_LABEL[rec.kind]}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
};
