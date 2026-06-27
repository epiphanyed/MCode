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
  securityLevel: 'loose'
});

export const DrawioViewer = ({ xmlData }: {xmlData: string;}) => {
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
      className="void-w-full void-h-96 void-border-none void-rounded void-bg-white" />);


};

export const DiagramContainer = ({
  type,
  code,
  errorMsg: initialErrorMsg,
  videoUrl: initialVideoUrl





}: {type: 'mermaid' | 'drawio' | 'manim';code: string;errorMsg?: string;videoUrl?: string;}) => {
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
    return () => {isMounted = false;};
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
    <div className="void-border void-border-void-border-3 void-rounded-lg void-overflow-hidden void-bg-void-bg-2 void-my-2 void-select-text">
			<div className="void-flex void-justify-between void-items-center void-bg-void-bg-1 void-px-3 void-py-1.5 void-border-b void-border-void-border-3 void-text-xs">
				<span className="void-font-mono void-text-void-fg-3 void-uppercase">{type} Diagram</span>
				<div className="void-flex void-gap-1.5">
					<button
            className={`void-px-2 void-py-0.5 void-rounded void-transition ${activeTab === 'preview' ? "void-bg-void-bg-3 void-text-void-fg-1 void-font-semibold" : "void-text-void-fg-3 hover:void-bg-void-bg-3"}`}
            onClick={() => setActiveTab('preview')}>
            
						Preview
					</button>
					<button
            className={`void-px-2 void-py-0.5 void-rounded void-transition ${activeTab === 'code' ? "void-bg-void-bg-3 void-text-void-fg-1 void-font-semibold" : "void-text-void-fg-3 hover:void-bg-void-bg-3"}`}
            onClick={() => setActiveTab('code')}>
            
						Source
					</button>
				</div>
			</div>

			<div className="void-p-3 void-overflow-auto void-max-h-96">
				{activeTab === 'preview' ?
        errorMsg ?
        <div className="void-text-red-500 void-text-xs void-font-mono void-whitespace-pre-wrap void-bg-red-950/20 void-p-2 void-rounded void-border void-border-red-900">
							<strong>⚠️ Render Failure:</strong><br />{errorMsg}
							{type === 'manim' &&
          <button
            onClick={handleCompileManim}
            className="void-mt-2 void-block void-px-3 void-py-1 void-bg-red-900 hover:void-bg-red-800 void-text-white void-rounded void-font-sans void-text-xs void-transition">
            
									Retry Compile
								</button>
          }
						</div> :
        type === 'mermaid' ?
        <div className="void-flex void-justify-center void-bg-void-bg-1 void-p-2 void-rounded" dangerouslySetInnerHTML={{ __html: renderedSvg }} /> :
        type === 'drawio' ?
        <DrawioViewer xmlData={code} /> :
        compiling ?
        <div className="void-flex void-flex-col void-items-center void-justify-center void-p-6 void-space-y-2">
							<div className="void-animate-spin void-rounded-full void-h-6 void-w-6 void-border-b-2 void-border-void-primary"></div>
							<span className="void-text-void-fg-3 void-text-xs">Compiling Manim Scene...</span>
						</div> :
        videoUrl ?
        <video src={getLocalResourceUrl(videoUrl)} controls autoPlay loop className="void-w-full void-rounded" /> :

        <div className="void-flex void-flex-col void-items-center void-justify-center void-p-4">
							<span className="void-text-void-fg-3 void-text-xs void-italic void-mb-2">Manim animation not compiled.</span>
							<button
            onClick={handleCompileManim}
            className="void-px-3 void-py-1 void-bg-void-bg-3 hover:void-bg-void-bg-1 void-text-void-fg-1 void-border void-border-void-border-3 void-rounded void-text-xs void-transition">
            
								Compile Animation
							</button>
						</div> :


        <pre className="void-text-xs void-font-mono void-text-void-fg-2 void-bg-void-bg-1 void-p-2 void-rounded void-whitespace-pre-wrap">{code}</pre>
        }
			</div>
		</div>);

};