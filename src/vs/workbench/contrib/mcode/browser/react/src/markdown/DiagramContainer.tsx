/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useState, useEffect, useRef } from 'react';
import mermaid from 'mermaid';
import { useAccessor } from '../util/services.js';
import { IVoidDiagramService } from '../../../../common/mcodeDiagramTypes.js';

// Initialize mermaid
mermaid.initialize({
	startOnLoad: false,
	theme: 'dark',
	securityLevel: 'loose',
});

export const DrawioViewer = ({ xmlData }: { xmlData: string }) => {
	const viewerUrl = `https://viewer.diagrams.net/?embed=1&proto=json`;
	const iframeRef = useRef<HTMLIFrameElement>(null);

	useEffect(() => {
		const handleMessage = (e: MessageEvent) => {
			if (e.source !== iframeRef.current?.contentWindow) return;
			try {
				const data = JSON.parse(e.data);
				if (data.event === 'init') {
					iframeRef.current?.contentWindow?.postMessage(JSON.stringify({
						action: 'load',
						xml: xmlData
					}), '*');
				}
			} catch (err) {}
		};
		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, [xmlData]);

	return (
		<iframe
			ref={iframeRef}
			src={viewerUrl}
			className="w-full h-96 border-none rounded bg-white"
		/>
	);
};

export const DiagramContainer = ({
	type,
	code,
	errorMsg: initialErrorMsg,
	videoUrl: initialVideoUrl
}: {
	type: 'mermaid' | 'drawio' | 'manim';
	code: string;
	errorMsg?: string;
	videoUrl?: string;
}) => {
	const accessor = useAccessor();
	const diagramService = accessor.get(IVoidDiagramService);
	const workspaceContextService = accessor.get('IWorkspaceContextService');

	const [activeTab, setActiveTab] = useState<'preview' | 'code'>('preview');
	const [renderedSvg, setRenderedSvg] = useState<string>('');
	const [errorMsg, setErrorMsg] = useState<string>(initialErrorMsg || '');
	const [compiling, setCompiling] = useState<boolean>(false);
	const [videoUrl, setVideoUrl] = useState<string>(initialVideoUrl || '');

	useEffect(() => {
		if (type !== 'mermaid') return;
		let isMounted = true;
		const renderMermaid = async () => {
			try {
				const cleanCode = code.trim();
				const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`;
				await mermaid.parse(cleanCode);
				const { svg } = await mermaid.render(id, cleanCode);
				if (isMounted) {
					setRenderedSvg(svg);
					setErrorMsg('');
				}
			} catch (err: any) {
				if (isMounted) {
					setErrorMsg(err.message || 'Mermaid syntax parsing failed.');
				}
			}
		};
		renderMermaid();
		return () => { isMounted = false; };
	}, [code, type]);

	const handleCompileManim = async () => {
		setCompiling(true);
		setErrorMsg('');
		try {
			const folders = workspaceContextService.getWorkspace().folders;
			const rootPath = folders[0]?.uri.fsPath;
			if (!rootPath) {
				setErrorMsg('No active workspace found to compile Manim.');
				return;
			}
			const res = await diagramService.renderManim(code, rootPath);
			if (res.success && res.mediaPath) {
				setVideoUrl(res.mediaPath);
			} else {
				setErrorMsg(res.error || 'Compilation failed.');
			}
		} catch (err: any) {
			setErrorMsg(err.message || 'Error executing compilation.');
		} finally {
			setCompiling(false);
		}
	};

	useEffect(() => {
		if (type === 'manim' && !videoUrl && !compiling) {
			handleCompileManim();
		}
	}, [type, code]);

	const getLocalResourceUrl = (absolutePath: string) => {
		let normalized = absolutePath.replace(/\\/g, '/');
		if (normalized.startsWith('file:///')) {
			normalized = normalized.substring(8);
		} else if (normalized.startsWith('file://')) {
			normalized = normalized.substring(7);
		}
		return `vscode-file://vscode-app/${normalized}`;
	};

	return (
		<div className="border border-void-border-3 rounded-lg overflow-hidden bg-void-bg-2 my-2 select-text">
			<div className="flex justify-between items-center bg-void-bg-1 px-3 py-1.5 border-b border-void-border-3 text-xs">
				<span className="font-mono text-void-fg-3 uppercase">{type} Diagram</span>
				<div className="flex gap-1.5">
					<button
						className={`px-2 py-0.5 rounded transition ${activeTab === 'preview' ? 'bg-void-bg-3 text-void-fg-1 font-semibold' : 'text-void-fg-3 hover:bg-void-bg-3'}`}
						onClick={() => setActiveTab('preview')}
					>
						Preview
					</button>
					<button
						className={`px-2 py-0.5 rounded transition ${activeTab === 'code' ? 'bg-void-bg-3 text-void-fg-1 font-semibold' : 'text-void-fg-3 hover:bg-void-bg-3'}`}
						onClick={() => setActiveTab('code')}
					>
						Source
					</button>
				</div>
			</div>

			<div className="p-3 overflow-auto max-h-96">
				{activeTab === 'preview' ? (
					errorMsg ? (
						<div className="text-red-500 text-xs font-mono whitespace-pre-wrap bg-red-950/20 p-2 rounded border border-red-900">
							<strong>⚠️ Render Failure:</strong><br />{errorMsg}
							{type === 'manim' && (
								<button
									onClick={handleCompileManim}
									className="mt-2 block px-3 py-1 bg-red-900 hover:bg-red-800 text-white rounded font-sans text-xs transition"
								>
									Retry Compile
								</button>
							)}
						</div>
					) : type === 'mermaid' ? (
						<div className="flex justify-center bg-void-bg-1 p-2 rounded" dangerouslySetInnerHTML={{ __html: renderedSvg }} />
					) : type === 'drawio' ? (
						<DrawioViewer xmlData={code} />
					) : compiling ? (
						<div className="flex flex-col items-center justify-center p-6 space-y-2">
							<div className="animate-spin rounded-full h-6 w-6 border-b-2 border-void-primary"></div>
							<span className="text-void-fg-3 text-xs">Compiling Manim Scene...</span>
						</div>
					) : videoUrl ? (
						<video src={getLocalResourceUrl(videoUrl)} controls autoPlay loop className="w-full rounded" />
					) : (
						<div className="flex flex-col items-center justify-center p-4">
							<span className="text-void-fg-3 text-xs italic mb-2">Manim animation not compiled.</span>
							<button
								onClick={handleCompileManim}
								className="px-3 py-1 bg-void-bg-3 hover:bg-void-bg-1 text-void-fg-1 border border-void-border-3 rounded text-xs transition"
							>
								Compile Animation
							</button>
						</div>
					)
				) : (
					<pre className="text-xs font-mono text-void-fg-2 bg-void-bg-1 p-2 rounded whitespace-pre-wrap">{code}</pre>
				)}
			</div>
		</div>
	);
};
