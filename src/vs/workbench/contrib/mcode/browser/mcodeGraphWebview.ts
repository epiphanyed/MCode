import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { ACTIVE_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { CodeGraphViewOptions, CodeGraphViewPayload, IVoidRagService } from '../common/mcodeRagTypes.js';
import { URI } from '../../../../base/common/uri.js';
import { FileAccess } from '../../../../base/common/network.js';
import { asWebviewUri } from '../../webview/common/webview.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { isCodeEditor, ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';

const GRAPH_VIEW_TYPE = 'codebaseGraph';

let currentGraphWebview: WebviewInput | undefined;
let graphRefreshRagService: IVoidRagService | undefined;
let graphWebviewMessageDisposable: IDisposable | undefined;

function findOpenGraphWebview(editorService: IEditorService): WebviewInput | undefined {
	for (const editor of editorService.editors) {
		if (editor instanceof WebviewInput && editor.viewType === GRAPH_VIEW_TYPE && !editor.isDisposed()) {
			return editor;
		}
	}
	return undefined;
}

function isUsableGraphWebview(input: WebviewInput | undefined): input is WebviewInput {
	return !!input && !input.isDisposed();
}

function clearGraphWebviewRef(input?: WebviewInput): void {
	if (!input || currentGraphWebview === input) {
		currentGraphWebview = undefined;
	}
}

export function highlightGraphNodeForEditor(filePath: string, lineNumber: number): void {
	if (!isUsableGraphWebview(currentGraphWebview)) {
		return;
	}
	currentGraphWebview.webview.postMessage({
		command: 'highlightEditorPosition',
		filePath,
		lineNumber,
	});
}

/** Ask open graph webview to remeasure canvas (e.g. after workbench sidebar toggles). */
export function relayoutGraphWebview(): void {
	if (!isUsableGraphWebview(currentGraphWebview)) {
		return;
	}
	currentGraphWebview.webview.postMessage({ command: 'relayout' });
}

let graphScriptUris: { visNetwork: string; forceGraph3d: string } | undefined;

function getGraphScriptUris(): { visNetwork: string; forceGraph3d: string } {
	if (!graphScriptUris) {
		const vendorBase = FileAccess.asFileUri('vs/workbench/contrib/mcode/browser/media/graph-vendor');
		graphScriptUris = {
			visNetwork: asWebviewUri(URI.joinPath(vendorBase, 'vis-network.min.js')).toString(),
			forceGraph3d: asWebviewUri(URI.joinPath(vendorBase, '3d-force-graph.min.js')).toString(),
		};
	}
	return graphScriptUris;
}

function getGraphVendorResourceRoot(): URI {
	return FileAccess.asFileUri('vs/workbench/contrib/mcode/browser/media/graph-vendor');
}

let graphViewOptions: CodeGraphViewOptions = { displayScope: 'overview' };

function resetGraphViewOptions(): void {
	graphViewOptions = { displayScope: 'overview' };
}

function clearGraphFocus(): void {
	delete graphViewOptions.focusFilePath;
	delete graphViewOptions.pendingSearchQuery;
}

async function reloadGraphView(webviewInput: WebviewInput, ragService: IVoidRagService, editorService: IEditorService): Promise<void> {
	const payload = await ragService.getCodeGraphViewPayload(graphViewOptions);
	const control = editorService.activeTextEditorControl;
	let activeFilePath: string | undefined;
	let activeLineNumber = 1;
	if (isCodeEditor(control)) {
		const model = control.getModel();
		const selection = control.getSelection();
		if (model && selection) {
			activeFilePath = model.uri.fsPath;
			activeLineNumber = selection.startLineNumber;
		}
	}
	webviewInput.webview.setHtml(getGraphHtml(payload, getGraphScriptUris(), activeFilePath, activeLineNumber));
	setTimeout(() => relayoutGraphWebview(), 350);
}

async function refreshGraphWebview(ragService: IVoidRagService): Promise<void> {
	const webviewInput = currentGraphWebview;
	if (!isUsableGraphWebview(webviewInput)) {
		currentGraphWebview = undefined;
		return;
	}
	const payload = await ragService.getCodeGraphViewPayload(graphViewOptions);
	webviewInput.webview.postMessage({ command: 'updatePayload', payload });
	relayoutGraphWebview();
}

function wireGraphWebviewMessages(
	webviewInput: WebviewInput,
	editorService: IEditorService,
	ragService: IVoidRagService,
): void {
	graphWebviewMessageDisposable?.dispose();
	graphWebviewMessageDisposable = webviewInput.webview.onMessage(async e => {
		const msg = e.message as {
			command?: string;
			filePath?: string;
			startLine?: number;
			displayScope?: CodeGraphViewOptions['displayScope'];
			focusFilePath?: string;
			pendingSearchQuery?: string;
			clearFocus?: boolean;
		};
		if (msg.command === 'openFile' && msg.filePath) {
			const startLine = msg.startLine || 1;
			editorService.openEditor({
				resource: URI.file(msg.filePath),
				options: {
					pinned: true,
					revealIfOpened: true,
					revealIfVisible: true,
					activation: 1, // EditorActivation.ACTIVATE
					selection: {
						startLineNumber: startLine,
						startColumn: 1,
						endLineNumber: startLine,
						endColumn: 1
					}
				}
			});
		} else if (msg.command === 'setViewOptions') {
			if (msg.clearFocus) {
				resetGraphViewOptions();
				if (msg.displayScope) {
					graphViewOptions.displayScope = msg.displayScope;
				}
			} else if (msg.focusFilePath) {
				graphViewOptions = {
					displayScope: msg.displayScope ?? 'symbols',
					focusFilePath: msg.focusFilePath,
					pendingSearchQuery: msg.pendingSearchQuery,
				};
			} else {
				const scope = msg.displayScope ?? graphViewOptions.displayScope ?? 'overview';
				graphViewOptions.displayScope = scope;
				if (scope === 'overview') {
					clearGraphFocus();
				} else if ((scope === 'symbols' || scope === 'calls') && !graphViewOptions.focusFilePath) {
					const control = editorService.activeTextEditorControl;
					if (isCodeEditor(control)) {
						const model = control.getModel();
						if (model) {
							graphViewOptions.focusFilePath = model.uri.fsPath;
						}
					}
				}
			}
			await reloadGraphView(webviewInput, ragService, editorService);
		} else if (msg.command === 'refresh') {
			clearGraphFocus();
			await reloadGraphView(webviewInput, ragService, editorService);
		}
	});
}

function createGraphWebview(
	webviewWorkbenchService: IWebviewWorkbenchService,
	title: string,
): WebviewInput {
	return webviewWorkbenchService.openWebview(
		{
			title,
			options: {
				tryRestoreScrollPosition: true,
				enableFindWidget: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [getGraphVendorResourceRoot()],
			},
			extension: undefined
		},
		GRAPH_VIEW_TYPE,
		title,
		{ group: ACTIVE_GROUP, preserveFocus: false }
	);
}

async function applyGraphHtml(webviewInput: WebviewInput, ragService: IVoidRagService, editorService: IEditorService): Promise<void> {
	await reloadGraphView(webviewInput, ragService, editorService);
}

export function registerGraphWebviewCommand() {
	CommandsRegistry.registerCommand('void.showGraph', async (accessor: ServicesAccessor) => {
		const webviewWorkbenchService = accessor.get(IWebviewWorkbenchService);
		const ragService = accessor.get(IVoidRagService);
		const editorService = accessor.get(IEditorService);

		graphRefreshRagService = ragService;
		resetGraphViewOptions();
		const title = 'Codebase Graph Topology';

		let webviewInput = findOpenGraphWebview(editorService) ?? currentGraphWebview;
		if (!isUsableGraphWebview(webviewInput)) {
			webviewInput = createGraphWebview(webviewWorkbenchService, title);
			currentGraphWebview = webviewInput;
			wireGraphWebviewMessages(webviewInput, editorService, ragService);
			webviewInput.onWillDispose(() => {
				clearGraphWebviewRef(webviewInput);
				if (graphWebviewMessageDisposable) {
					graphWebviewMessageDisposable.dispose();
					graphWebviewMessageDisposable = undefined;
				}
			});
			webviewInput.webview.onFatalError(() => clearGraphWebviewRef(webviewInput));
		} else {
			currentGraphWebview = webviewInput;
			webviewWorkbenchService.revealWebview(webviewInput, ACTIVE_GROUP, false);
			wireGraphWebviewMessages(webviewInput, editorService, ragService);
		}

		await applyGraphHtml(webviewInput, ragService, editorService);
	});
}

class GraphWebviewLifecycleContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.mcodeGraphWebviewLifecycle';

	constructor(
		@IEditorService editorService: IEditorService,
	) {
		super();
		this._register(editorService.onDidCloseEditor(e => {
			if (e.editor instanceof WebviewInput && e.editor.viewType === GRAPH_VIEW_TYPE) {
				clearGraphWebviewRef(e.editor);
			}
		}));
	}
}

class GraphWebviewEditorSyncContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.mcodeGraphWebviewEditorSync';

	private selectionListener: IDisposable | undefined;
	private readonly highlightScheduler: RunOnceScheduler;
	private lastFilePath = '';
	private lastLineNumber = 0;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this.highlightScheduler = this._register(new RunOnceScheduler(() => {
			if (this.lastFilePath) {
				highlightGraphNodeForEditor(this.lastFilePath, this.lastLineNumber);
			}
		}, 300));
		this._register(this.editorService.onDidActiveEditorChange(() => this.attachToActiveEditor()));
		this.attachToActiveEditor();
	}

	private attachToActiveEditor(): void {
		this.selectionListener?.dispose();
		this.selectionListener = undefined;
		const control = this.editorService.activeTextEditorControl;
		if (!isCodeEditor(control)) {
			return;
		}
		const editor = control;
		this.queueHighlightFromEditor(editor);
		this.selectionListener = editor.onDidChangeCursorSelection(() => this.queueHighlightFromEditor(editor));
	}

	private queueHighlightFromEditor(control: ICodeEditor): void {
		const model = control.getModel();
		const selection = control.getSelection();
		if (!model || !selection) {
			return;
		}
		this.lastFilePath = model.uri.fsPath;
		this.lastLineNumber = selection.startLineNumber;
		this.highlightScheduler.schedule();
	}

	override dispose(): void {
		this.selectionListener?.dispose();
		super.dispose();
	}
}

class GraphWebviewLayoutContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.mcodeGraphWebviewLayout';

	private readonly relayoutScheduler: RunOnceScheduler;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super();
		this.relayoutScheduler = this._register(new RunOnceScheduler(() => relayoutGraphWebview(), 180));
		const schedule = () => {
			if (isUsableGraphWebview(currentGraphWebview)) {
				this.relayoutScheduler.schedule();
			}
		};
		this._register(layoutService.onDidChangePartVisibility(schedule));
		this._register(layoutService.onDidChangePanelPosition(schedule));
		this._register(layoutService.onDidChangePanelAlignment(schedule));
		this._register(layoutService.onDidChangeWindowMaximized(schedule));
	}
}

class GraphWebviewRefreshContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.mcodeGraphWebviewRefresh';

	private readonly incrementalRefreshScheduler: RunOnceScheduler;

	constructor(
		@IVoidRagService private readonly ragService: IVoidRagService,
	) {
		super();
		graphRefreshRagService = ragService;
		this.incrementalRefreshScheduler = this._register(new RunOnceScheduler(() => {
			if (graphRefreshRagService && isUsableGraphWebview(currentGraphWebview)) {
				refreshGraphWebview(graphRefreshRagService);
			}
		}, 2500));
		this._register(this.ragService.onIndexComplete(() => {
			if (graphRefreshRagService && isUsableGraphWebview(currentGraphWebview)) {
				this.incrementalRefreshScheduler.cancel();
				refreshGraphWebview(graphRefreshRagService);
			}
		}));
		this._register(this.ragService.onIncrementalSync(() => {
			if (isUsableGraphWebview(currentGraphWebview)) {
				this.incrementalRefreshScheduler.schedule();
			}
		}));
	}
}

function getGraphHtml(
	payload: CodeGraphViewPayload,
	scriptUris: { visNetwork: string; forceGraph3d: string },
	activeFilePath?: string,
	activeLineNumber?: number,
): string {
	const dataStr = JSON.stringify(payload);
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Codebase Graph Topology</title>
	<style>
		:root {
			--bg-color: var(--vscode-editor-background, #1e1e1e);
			--fg-color: var(--vscode-editor-foreground, #bbbbbb);
			--border-color: var(--vscode-panel-border, #3c3c3c);
			--accent-color: var(--vscode-button-background, #007acc);
			--accent-hover: var(--vscode-button-hoverBackground, #0062a3);
			--panel-bg: var(--vscode-sideBar-background, #252526);
		}
		body, html {
			margin: 0;
			padding: 0;
			width: 100%;
			height: 100%;
			min-height: 100%;
			overflow: hidden;
			background-color: var(--bg-color);
			color: var(--fg-color);
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		}
		#container {
			position: fixed;
			inset: 0;
			display: flex;
			flex-direction: row;
			width: 100%;
			height: 100%;
			background-color: var(--bg-color);
			overflow: hidden;
		}
		#graphHost {
			flex: 1 1 auto;
			min-width: 0;
			position: relative;
			height: 100%;
			background-color: var(--bg-color);
		}
		#graph2d, #graph3d {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
		}
		#graph2d canvas,
		#graph3d canvas {
			display: block;
		}
		.hidden {
			display: none !important;
		}
		.overlay-panel {
			position: absolute;
			top: 15px;
			left: 15px;
			z-index: 10;
			background-color: rgba(30, 30, 30, 0.85);
			backdrop-filter: blur(10px);
			border: 1px solid var(--border-color);
			border-radius: 6px;
			padding: 12px 18px;
			box-shadow: 0 4px 20px rgba(0,0,0,0.3);
			max-width: 320px;
		}
		.hub-panel {
			position: absolute;
			bottom: 15px;
			left: 15px;
			z-index: 10;
			background-color: rgba(30, 30, 30, 0.85);
			backdrop-filter: blur(10px);
			border: 1px solid var(--border-color);
			border-radius: 6px;
			padding: 12px 18px;
			box-shadow: 0 4px 20px rgba(0,0,0,0.3);
			max-width: 320px;
			max-height: 180px;
			overflow-y: auto;
		}
		.community-panel {
			position: absolute;
			bottom: 15px;
			left: 350px;
			z-index: 10;
			background-color: rgba(30, 30, 30, 0.85);
			backdrop-filter: blur(10px);
			border: 1px solid var(--border-color);
			border-radius: 6px;
			padding: 12px 18px;
			box-shadow: 0 4px 20px rgba(0,0,0,0.3);
			max-width: 260px;
			max-height: 180px;
			overflow-y: auto;
		}
		.right-panel {
			flex: 0 0 300px;
			width: 300px;
			height: 100%;
			box-sizing: border-box;
			z-index: 10;
			background-color: rgba(30, 30, 30, 0.92);
			backdrop-filter: blur(10px);
			border-left: 1px solid var(--border-color);
			padding: 12px 18px;
			overflow-y: auto;
		}
		.right-panel.collapsed {
			display: none;
		}
		.panel-header-row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
		}
		.panel-header-row h3 {
			flex: 1;
			margin-bottom: 8px;
		}
		.panel-close-btn {
			background: transparent;
			border: 1px solid var(--border-color);
			color: var(--fg-color);
			border-radius: 4px;
			width: 24px;
			height: 24px;
			cursor: pointer;
			font-size: 14px;
			line-height: 1;
			flex-shrink: 0;
		}
		.panel-close-btn:hover {
			background: rgba(255,255,255,0.08);
		}
		.panel-reopen-btn {
			position: absolute;
			top: 15px;
			right: 15px;
			z-index: 10;
			display: none;
		}
		.panel-reopen-btn.visible {
			display: block;
		}
		.search-status {
			font-size: 10px;
			color: #888888;
			min-height: 14px;
			margin-bottom: 4px;
		}
		h3 {
			margin-top: 0;
			margin-bottom: 8px;
			font-size: 14px;
			text-transform: uppercase;
			letter-spacing: 0.8px;
			color: #ffffff;
			border-bottom: 1px solid var(--border-color);
			padding-bottom: 4px;
		}
		.btn {
			background-color: var(--accent-color);
			color: white;
			border: none;
			border-radius: 4px;
			padding: 6px 12px;
			cursor: pointer;
			font-size: 12px;
			font-weight: 500;
			transition: background-color 0.2s ease;
		}
		.btn:hover {
			background-color: var(--accent-hover);
		}
		.btn-row {
			display: flex;
			gap: 6px;
			margin-bottom: 10px;
		}
		.search-box {
			width: 90%;
			background-color: rgba(0,0,0,0.3);
			border: 1px solid var(--border-color);
			color: #ffffff;
			padding: 6px;
			border-radius: 4px;
			font-size: 12px;
			margin-bottom: 8px;
		}
		.view-select {
			width: 100%;
			background-color: rgba(0,0,0,0.3);
			border: 1px solid var(--border-color);
			color: #ffffff;
			padding: 6px;
			border-radius: 4px;
			font-size: 11px;
			margin-bottom: 6px;
		}
		.btn-small {
			font-size: 10px;
			padding: 4px 8px;
			margin-bottom: 8px;
		}
		.legend-item {
			display: flex;
			align-items: center;
			margin-bottom: 6px;
			font-size: 11px;
		}
		.color-box {
			width: 12px;
			height: 12px;
			border-radius: 50%;
			margin-right: 8px;
			flex-shrink: 0;
		}
		.detail-item {
			font-size: 11px;
			margin-bottom: 6px;
			word-break: break-all;
		}
		.detail-label {
			font-weight: bold;
			color: #888888;
		}
		.info-tip {
			font-size: 10px;
			color: #888888;
			margin-top: 10px;
			border-top: 1px dashed var(--border-color);
			padding-top: 6px;
		}
		.hub-item {
			font-size: 11px;
			margin-bottom: 5px;
			cursor: pointer;
			padding: 3px 4px;
			border-radius: 3px;
		}
		.hub-item:hover {
			background-color: rgba(255,255,255,0.08);
		}
		.hub-degree {
			color: #888888;
		}
		.community-item {
			font-size: 11px;
			margin-bottom: 5px;
			cursor: pointer;
			padding: 3px 4px;
			border-radius: 3px;
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.community-item:hover {
			background-color: rgba(255,255,255,0.08);
		}
		.community-dot {
			width: 10px;
			height: 10px;
			border-radius: 50%;
			flex-shrink: 0;
		}
	</style>
	<script src="${scriptUris.visNetwork}"></script>
	<script src="${scriptUris.forceGraph3d}"></script>
</head>
<body>
	<div id="container">
		<div id="graphHost">
		<div id="graph2d"></div>
		<div id="graph3d" class="hidden"></div>

		<div class="overlay-panel">
			<h3>MCode Graphify</h3>
			<div id="viewModeBanner" style="display:none;font-size:10px;color:#ffb347;margin-bottom:8px;"></div>
			<div class="btn-row">
				<button id="toggleBtn" class="btn">Switch to 3D View</button>
				<button id="refreshBtn" class="btn">Refresh</button>
			</div>
			<select id="viewScopeSelect" class="view-select" title="Graph display scope">
				<option value="overview">Overview — file map</option>
				<option value="symbols">Symbol detail — class / function nodes</option>
				<option value="calls">Call graph — calls + inheritance</option>
			</select>
			<button id="resetFocusBtn" class="btn btn-small" style="display:none;">Back to full overview</button>
			<div>
				<input type="text" id="searchField" class="search-box" placeholder="Filter classes/functions/files..." />
				<div id="searchStatus" class="search-status"></div>
			</div>
			<div id="legend" style="margin-top: 10px;">
				<div class="legend-item"><div class="color-box" style="background-color: #51a7f9;"></div>File Node (文件)</div>
				<div class="legend-item"><div class="color-box" style="background-color: #f7a35c;"></div>Class / Interface (类/接口)</div>
				<div class="legend-item"><div class="color-box" style="background-color: #90ed7d;"></div>Function / Method (函数/方法)</div>
				<div class="legend-item"><div class="color-box" style="background-color: #d175ff;"></div>Import Relation (导入关系)</div>
				<div class="legend-item"><div class="color-box" style="background-color: #ff5e62;"></div>Call Relation (调用关系)</div>
				<div class="legend-item"><div class="color-box" style="background-color: #ffb347;"></div>Inheritance (继承)</div>
				<div class="legend-item"><div class="color-box" style="background-color: #87ceeb;"></div>Contains (包含)</div>
			</div>
			<div class="info-tip">
				💡 Search a class → Enter opens source and switches to symbol view. Use the dropdown for call graph. Double-click a node to open its file.
			</div>
		</div>

		<div class="hub-panel" id="hubPanel">
			<h3>Top Hub Nodes</h3>
			<div id="hubList"></div>
		</div>

		<div class="community-panel" id="communityPanel">
			<h3 id="communityPanelTitle">Communities</h3>
			<div id="communityList"></div>
		</div>

		<button id="reopenDetailPanel" class="btn panel-reopen-btn" title="Show details panel">Details</button>
		</div>

		<div class="right-panel" id="detailPanel">
			<div class="panel-header-row">
				<h3>Selected Node Details</h3>
				<button id="closeDetailPanel" class="panel-close-btn" title="Hide details panel">&times;</button>
			</div>
			<div id="detailsContent">
				<div style="color: #888888; font-size: 12px; font-style: italic;">Click a node to view its structural information and file parameters.</div>
			</div>
			<h3 style="margin-top: 14px;">GRAPH_REPORT</h3>
			<pre id="reportContent" style="font-size: 10px; white-space: pre-wrap; max-height: 220px; overflow-y: auto; color: #cccccc; margin: 0;"></pre>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

		let payload = ${dataStr};
		let rawData = payload.graph;
		let nodeDegrees = payload.nodeDegrees || {};
		let hubNodes = payload.hubNodes || [];
		let communities = payload.communities || [];
		let nodeCommunity = payload.nodeCommunity || {};
		let communityColors = payload.communityColors || {};
		let communityMethod = payload.communityMethod || 'components';
		let graphModularity = payload.graphModularity;
		let architectureReport = payload.architectureReport || '';
		let fileSymbolIndex = payload.fileSymbolIndex || {};
		let symbolSearchIndex = payload.symbolSearchIndex || {};

		let mode = '2d';
		let network2d = null;
		let graph3dInstance = null;
		let last3dNodeClick = { id: null, time: 0 };
		let nodesList = [];
		let edgesList = [];
		let lastEditorHighlightId = null;
		let searchDebounceTimer = null;
		let lastSearchQuery = '';
		let searchResultIndex = 0;
		let lastHighlightFilePath = ${activeFilePath ? JSON.stringify(activeFilePath) : '""'};
		let lastHighlightLineNumber = ${activeLineNumber ?? 0};

		function edgeColor(kind) {
			if (kind === 'imports') return '#d175ff';
			if (kind === 'inherits') return '#ffb347';
			if (kind === 'contains') return '#87ceeb';
			return '#ff5e62';
		}

		function normalizePath(p) {
			return (p || '').replace(/\\\\/g, '/').toLowerCase();
		}

		function nodeVal(id) {
			const deg = nodeDegrees[id] || 1;
			return Math.max(1, Math.min(20, deg * 2));
		}

		function nodeSize2d(id) {
			const deg = nodeDegrees[id] || 1;
			return 10 + Math.min(30, deg * 3);
		}

		function destroyGraphInstances() {
			if (network2d) {
				network2d.destroy();
				network2d = null;
			}
			if (graph3dInstance) {
				const container = document.getElementById('graph3d');
				if (container) {
					container.innerHTML = '';
				}
				graph3dInstance = null;
			}
			lastEditorHighlightId = null;
		}

		function showEmptyGraphMessage(message) {
			const graph2dEl = document.getElementById('graph2d');
			if (graph2dEl) {
				graph2dEl.innerHTML = '<div style="padding:24px;color:#aaa;font-size:13px;line-height:1.5;max-width:420px;">' + message + '</div>';
			}
		}

		function buildNodeEdgeLists() {
			nodesList = [];
			edgesList = [];
			Object.keys(rawData.nodes).forEach(id => {
				const rawNode = rawData.nodes[id];
				let color = '#51a7f9';
				if (rawNode.symbolType === 'class' || rawNode.symbolType === 'interface') {
					color = '#f7a35c';
				} else if (rawNode.symbolType === 'function' || rawNode.symbolType === 'method') {
					color = '#90ed7d';
				}
				const commId = nodeCommunity[id];
				const borderColor = commId !== undefined && communityColors[commId]
					? communityColors[commId]
					: color;

				nodesList.push({
					id: id,
					label: rawNode.symbolName || id.split(/[\\\\/]/).pop(),
					title: rawNode.filePath,
					color: { background: color, border: borderColor, highlight: { background: '#ffeb3b', border: borderColor } },
					val: nodeVal(id),
					size: nodeSize2d(id),
					raw: rawNode,
					baseColor: color,
					communityId: nodeCommunity[id]
				});
			});

			rawData.edges.forEach(edge => {
				edgesList.push({
					source: edge.from,
					target: edge.to,
					from: edge.from,
					to: edge.to,
					color: edgeColor(edge.kind),
					arrows: edge.kind === 'contains' ? '' : 'to',
					kind: edge.kind
				});
			});
		}

		function updateViewModeBanner() {
			const banner = document.getElementById('viewModeBanner');
			const resetBtn = document.getElementById('resetFocusBtn');
			const scopeSelect = document.getElementById('viewScopeSelect');
			if (scopeSelect && payload.displayScope) {
				scopeSelect.value = payload.displayScope;
			}
			if (resetBtn) {
				resetBtn.style.display = payload.focusFilePath ? 'inline-block' : 'none';
			}
			if (!banner) return;
			const total = payload.totalNodeCount || nodesList.length;
			const shown = nodesList.length;
			banner.style.display = 'block';
			if (shown === 0 && total === 0) {
				banner.textContent = 'No code graph indexed yet. Open Settings → Rebuild Index, then Refresh here.';
			} else if (shown === 0 && total > 0) {
				banner.textContent = 'Graph empty for current view — switch to Overview or click Back to full overview / Refresh.';
			} else if (payload.viewMode === 'focus-symbol') {
				const fileLabel = (payload.focusFilePath || '').split(/[\\\\/]/).pop() || 'file';
				banner.textContent = 'Symbol view: ' + fileLabel + ' (' + shown + ' nodes, ' + total + ' indexed). Orange=class, green=function/method.';
			} else if (payload.displayScope === 'calls') {
				banner.textContent = 'Call graph — red=calls, orange=inheritance. Imports and contains edges hidden.';
			} else if (payload.viewMode === 'file') {
				banner.textContent = 'File overview — ' + shown + ' files (' + total + ' symbols). Enter on search drills into symbol view.';
			} else if (payload.viewMode === 'file-sampled') {
				banner.textContent = 'Sampled file overview — top ' + shown + ' of ' + total + ' nodes. Enter on search drills into that file.';
			} else if (payload.displayScope === 'symbols') {
				banner.textContent = 'Symbol detail — ' + shown + ' class/function nodes across workspace.';
			} else {
				banner.textContent = 'Full symbol graph — ' + shown + ' nodes.';
			}
		}

		function pickDefaultMode() {
			mode = nodesList.length > 200 ? '3d' : '2d';
			if (mode === '3d') {
				document.getElementById('toggleBtn').innerText = 'Switch to 2D View';
				document.getElementById('graph2d').classList.add('hidden');
				document.getElementById('graph3d').classList.remove('hidden');
			} else {
				document.getElementById('toggleBtn').innerText = 'Switch to 3D View';
				document.getElementById('graph3d').classList.add('hidden');
				document.getElementById('graph2d').classList.remove('hidden');
			}
		}

		function applyNodeColorUpdates(updates) {
			if (mode === '2d' && network2d) {
				network2d.body.data.nodes.update(updates);
			} else if (mode === '3d' && graph3dInstance) {
				const colorMap = new Map(updates.map(u => [u.id, u.color]));
				graph3dInstance.nodeColor(node => {
					const c = colorMap.get(node.id);
					return typeof c === 'string' ? c : (c?.background ?? node.baseColor);
				});
			}
		}

		function resizeGraphCanvas() {
			const graphHost = document.getElementById('graphHost');
			const graph2dEl = document.getElementById('graph2d');
			const graph3dEl = document.getElementById('graph3d');
			const w = graphHost?.clientWidth || window.innerWidth;
			const h = graphHost?.clientHeight || window.innerHeight;
			if (w <= 0 || h <= 0) {
				return;
			}
			for (const el of [graph2dEl, graph3dEl]) {
				if (!el) continue;
				el.style.width = w + 'px';
				el.style.height = h + 'px';
				const canvas = el.querySelector('canvas');
				if (canvas) {
					canvas.style.width = w + 'px';
					canvas.style.height = h + 'px';
				}
			}
			if (network2d) {
				network2d.setSize(w + 'px', h + 'px');
			}
			if (graph3dInstance) {
				graph3dInstance.width(w).height(h);
			}
		}

		function fitGraphToView() {
			if (mode === '2d' && network2d) {
				try {
					network2d.fit({ animation: { duration: 280 } });
				} catch (_) {
					network2d.fit();
				}
			} else if (mode === '3d' && graph3dInstance) {
				try {
					graph3dInstance.zoomToFit(400, 80);
				} catch (_) {
					/* zoomToFit optional */
				}
			}
		}

		function scheduleGraphRelayout() {
			requestAnimationFrame(() => {
				resizeGraphCanvas();
				fitGraphToView();
			});
			setTimeout(() => { resizeGraphCanvas(); fitGraphToView(); }, 80);
			setTimeout(() => { resizeGraphCanvas(); fitGraphToView(); }, 280);
		}

		function symbolsForNode(n) {
			if (n.raw.containedSymbolNames?.length) {
				return n.raw.containedSymbolNames;
			}
			const fp = normalizePath(n.raw.filePath);
			for (const [pathKey, syms] of Object.entries(fileSymbolIndex)) {
				if (normalizePath(pathKey) === fp) {
					return syms;
				}
			}
			return [];
		}

		function resolveSymbolLocations(query) {
			const q = (query || '').toLowerCase().trim();
			if (!q) {
				return [];
			}
			const exact = symbolSearchIndex[q];
			if (exact?.length) {
				return exact;
			}
			const partial = [];
			for (const [name, locs] of Object.entries(symbolSearchIndex)) {
				if (name.includes(q)) {
					partial.push(...locs);
				}
			}
			if (partial.length) {
				return partial;
			}
			for (const [fp, syms] of Object.entries(fileSymbolIndex)) {
				for (const sym of syms) {
					if (sym.toLowerCase().includes(q)) {
						partial.push({ filePath: fp, startLine: 1, symbolName: sym });
					}
				}
			}
			return partial;
		}

		function findNodeForFilePath(filePath) {
			const norm = normalizePath(filePath);
			return nodesList.find(n => normalizePath(n.raw.filePath) === norm);
		}

		function openFileAtLocation(filePath, startLine) {
			vscode.postMessage({
				command: 'openFile',
				filePath,
				startLine: startLine || 1,
			});
		}

		function needsFocusDrillDown(symbolLocs, pickIdx) {
			if (!symbolLocs.length) {
				return false;
			}
			const currentScope = document.getElementById('viewScopeSelect')?.value || 'overview';
			if (currentScope === 'overview') {
				return true;
			}
			const loc = symbolLocs[pickIdx % symbolLocs.length];
			if (payload.focusFilePath && normalizePath(payload.focusFilePath) === normalizePath(loc.filePath)) {
				return false;
			}
			const node = findNodeForFilePath(loc.filePath);
			return !node;
		}

		function activateSearchResult(query, opts) {
			const q = (query || '').trim();
			if (!q) {
				return;
			}
			if (q !== lastSearchQuery) {
				lastSearchQuery = q;
				searchResultIndex = 0;
			} else if (opts && opts.advance) {
				searchResultIndex += 1;
			}

			const nodeMatches = nodesList.filter(n => nodeMatchesQuery(n, q));
			const symbolLocs = resolveSymbolLocations(q);
			const totalResults = Math.max(nodeMatches.length, symbolLocs.length);
			if (totalResults === 0) {
				return;
			}
			const pickIdx = searchResultIndex % totalResults;

			if (needsFocusDrillDown(symbolLocs, pickIdx)) {
				const loc = symbolLocs[pickIdx % symbolLocs.length];
				if (opts && opts.openFile) {
					openFileAtLocation(loc.filePath, loc.startLine);
				}
				const currentScope = document.getElementById('viewScopeSelect')?.value || 'symbols';
				const targetScope = currentScope === 'overview' ? 'symbols' : currentScope;
				vscode.postMessage({
					command: 'setViewOptions',
					displayScope: targetScope,
					focusFilePath: loc.filePath,
					pendingSearchQuery: q,
				});
				return;
			}

			applySearchFilter(q);

			if (nodeMatches.length > 0) {
				const node = nodeMatches[pickIdx % nodeMatches.length];
				focusNode(node.id);
			} else if (symbolLocs.length > 0) {
				const loc = symbolLocs[pickIdx % symbolLocs.length];
				const node = findNodeForFilePath(loc.filePath);
				if (node) {
					focusNode(node.id);
				}
			}

			if (opts && opts.openFile) {
				if (symbolLocs.length > 0) {
					const loc = symbolLocs[pickIdx % symbolLocs.length];
					openFileAtLocation(loc.filePath, loc.startLine);
				} else if (nodeMatches.length > 0) {
					const node = nodeMatches[pickIdx % nodeMatches.length];
					openFileAtLocation(node.raw.filePath, node.raw.startLine);
				}
			}

			const statusEl = document.getElementById('searchStatus');
			if (statusEl && totalResults > 1) {
				const current = (pickIdx % totalResults) + 1;
				statusEl.textContent = current + ' / ' + totalResults + ' — Enter opens source, Shift+Enter next';
			}
		}

		function nodeMatchesQuery(n, query) {
			if (!query) {
				return true;
			}
			const q = query.toLowerCase();
			const label = (n.label || '').toLowerCase();
			const sym = (n.raw.symbolName || '').toLowerCase();
			const path = normalizePath(n.raw.filePath);
			const fileName = path.split('/').pop() || '';
			const nodeId = (n.id || '').toLowerCase();
			if (sym.includes(q) || path.includes(q) || label.includes(q) || fileName.includes(q) || nodeId.includes(q)) {
				return true;
			}
			return symbolsForNode(n).some(s => s.toLowerCase().includes(q));
		}

		function findSymbolMatchesOffView(query) {
			const q = query.toLowerCase();
			const visibleFiles = new Set(nodesList.map(n => normalizePath(n.raw.filePath)));
			const hits = [];
			for (const [fp, syms] of Object.entries(fileSymbolIndex)) {
				const norm = normalizePath(fp);
				if (visibleFiles.has(norm)) {
					continue;
				}
				if (syms.some(s => s.toLowerCase().includes(q))) {
					hits.push(fp);
				}
			}
			return hits;
		}

		function applySearchFilter(query) {
			query = (query || '').toLowerCase().trim();
			const matches = nodesList.filter(n => nodeMatchesQuery(n, query));
			const symbolLocs = query ? resolveSymbolLocations(query) : [];
			const statusEl = document.getElementById('searchStatus');
			if (statusEl) {
				if (!query) {
					statusEl.textContent = '';
				} else if (matches.length === 0 && symbolLocs.length === 0) {
					const offView = findSymbolMatchesOffView(query);
					if ((payload.totalNodeCount || 0) === 0) {
						statusEl.textContent = 'No graph index — Rebuild Index in Settings, then Refresh';
					} else if (offView.length > 0) {
						const sample = offView[0].split('/').pop() || offView[0];
						statusEl.textContent = 'Symbol in ' + offView.length + ' file(s) not shown (e.g. ' + sample + ') — Enter switches to symbol view';
					} else {
						statusEl.textContent = 'No matches — class may not be indexed yet (try Rebuild Index)';
					}
				} else if (matches.length === 0 && symbolLocs.length > 0) {
					const loc = symbolLocs[0];
					statusEl.textContent = 'Symbol "' + loc.symbolName + '" — Enter opens ' + (loc.filePath.split(/[\\\\/]/).pop() || loc.filePath);
				} else {
					statusEl.textContent = matches.length + ' match(es) — Enter opens source';
				}
			}

			if (mode === '2d' && network2d) {
				const updates = nodesList.map(n => {
					const match = nodeMatchesQuery(n, query);
					if (!query) {
						return { id: n.id, hidden: false, color: n.color };
					}
					return {
						id: n.id,
						hidden: !match,
						color: match
							? { background: '#ffeb3b', border: n.color.border, highlight: n.color.highlight }
							: { background: '#2a2a2a', border: '#1a1a1a', highlight: n.color.highlight },
					};
				});
				network2d.body.data.nodes.update(updates);
				if (query && matches.length > 0) {
					const target = matches[0];
					network2d.selectNodes([target.id]);
					network2d.focus(target.id, { scale: 1.2, animation: { duration: 400 } });
					showDetails(target);
				}
			} else if (mode === '3d' && graph3dInstance) {
				graph3dInstance.nodeVisibility(n => !query || nodeMatchesQuery(n, query));
				graph3dInstance.nodeColor(n => {
					if (!query) {
						return n.baseColor;
					}
					return nodeMatchesQuery(n, query) ? '#ffeb3b' : '#444444';
				});
				if (query && matches.length > 0) {
					const gNode = graph3dInstance.graphData().nodes.find(x => x.id === matches[0].id);
					if (gNode) {
						graph3dInstance.cameraPosition(
							{ x: gNode.x, y: gNode.y, z: (gNode.z || 0) + 80 },
							gNode,
							800
						);
					}
				}
			}
		}

		function getSearchQuery() {
			return (document.getElementById('searchField')?.value || '').trim();
		}

		function setDetailPanelVisible(visible) {
			const panel = document.getElementById('detailPanel');
			const reopenBtn = document.getElementById('reopenDetailPanel');
			if (panel) {
				panel.classList.toggle('collapsed', !visible);
			}
			if (reopenBtn) {
				reopenBtn.classList.toggle('visible', !visible);
			}
			scheduleGraphRelayout();
		}

		function renderCommunityList() {
			const list = document.getElementById('communityList');
			const title = document.getElementById('communityPanelTitle');
			const methodHint = communityMethod === 'louvain' || communityMethod === 'louvain-file'
				? ((communityMethod === 'louvain-file' ? 'File Louvain ' : 'Louvain ')
					+ (graphModularity !== undefined ? 'Q≈' + graphModularity.toFixed(3) : '')).trim()
				: 'Components';
			if (title) {
				title.textContent = 'Communities (' + methodHint + ')';
			}
			if (!communities.length) {
				list.innerHTML = '<div style="font-size:11px;color:#888;">No communities detected.</div>';
				return;
			}
			list.innerHTML = communities.map(c =>
				'<div class="community-item" data-id="' + c.id + '">' +
				'<span class="community-dot" style="background:' + c.color + '"></span>' +
				'<span>' + c.label + ' (' + c.size + ')</span></div>'
			).join('');
			list.querySelectorAll('.community-item').forEach(el => {
				el.addEventListener('click', () => highlightCommunity(Number(el.getAttribute('data-id'))));
			});
		}

		function highlightCommunity(communityId) {
			const memberIds = new Set((communities.find(c => c.id === communityId)?.nodeIds) || []);
			if (mode === '2d' && network2d) {
				network2d.body.data.nodes.update(nodesList.map(n => ({
					id: n.id,
					color: memberIds.has(n.id)
						? { background: '#ffeb3b', border: n.color.border, highlight: n.color.highlight }
						: n.color
				})));
			} else if (mode === '3d' && graph3dInstance) {
				graph3dInstance.nodeColor(n => memberIds.has(n.id) ? '#ffeb3b' : n.baseColor);
			}
		}

		function renderHubList() {
			const hubList = document.getElementById('hubList');
			if (!hubNodes.length) {
				hubList.innerHTML = '<div style="font-size:11px;color:#888;">No hub data yet — index the workspace first.</div>';
				return;
			}
			hubList.innerHTML = hubNodes.map((h, i) => {
				const label = h.symbolName || h.filePath.split(/[\\\\/]/).pop();
				return '<div class="hub-item" data-id="' + h.id + '">' +
					(i + 1) + '. ' + label + ' <span class="hub-degree">(deg ' + h.degree + ')</span></div>';
			}).join('');
			hubList.querySelectorAll('.hub-item').forEach(el => {
				el.addEventListener('click', () => focusNode(el.getAttribute('data-id')));
			});
		}

		function focusNode(nodeId) {
			const node = nodesList.find(n => n.id === nodeId);
			if (!node) return;
			showDetails(node);
			if (mode === '2d' && network2d) {
				network2d.selectNodes([nodeId]);
				network2d.focus(nodeId, { scale: 1.2, animation: true });
			} else if (mode === '3d' && graph3dInstance) {
				const gNode = graph3dInstance.graphData().nodes.find(n => n.id === nodeId);
				if (gNode) {
					graph3dInstance.cameraPosition(
						{ x: gNode.x, y: gNode.y, z: (gNode.z || 0) + 80 },
						gNode,
						1000
					);
				}
			}
		}

		function init2D() {
			if (network2d) return;
			const container = document.getElementById('graph2d');
			const data = {
				nodes: new vis.DataSet(nodesList),
				edges: new vis.DataSet(edgesList)
			};
			const options = {
				nodes: {
					shape: 'dot',
					font: {
						color: '#ffffff',
						size: 12,
						strokeWidth: 3,
						strokeColor: '#1e1e1e'
					},
					borderWidth: 2,
					borderWidthSelected: 4
				},
				edges: {
					width: 1.5,
					arrows: {
						to: { enabled: true, scaleFactor: 0.8 }
					},
					smooth: {
						type: 'continuous'
					}
				},
				physics: {
					enabled: true,
					stabilization: {
						enabled: true,
						iterations: Math.min(120, Math.max(30, Math.floor(nodesList.length / 3)))
					},
					barnesHut: {
						gravitationalConstant: -2000,
						centralGravity: 0.3,
						springLength: 95
					}
				}
			};
			network2d = new vis.Network(container, data, options);

			network2d.on("stabilizationFinished", function () {
				network2d.setOptions({ physics: { enabled: false } });
			});

			network2d.on("click", function (params) {
				if (params.nodes.length > 0) {
					const nodeId = params.nodes[0];
					const node = nodesList.find(n => n.id === nodeId);
					showDetails(node);
				}
			});

			network2d.on("doubleClick", function (params) {
				if (params.nodes.length > 0) {
					const nodeId = params.nodes[0];
					const node = nodesList.find(n => n.id === nodeId);
					vscode.postMessage({
						command: 'openFile',
						filePath: node.raw.filePath,
						startLine: node.raw.startLine
					});
				}
			});
			requestAnimationFrame(() => {
				resizeGraphCanvas();
				applySearchFilter(getSearchQuery());
				fitGraphToView();
			});
		}

		function init3D() {
			if (graph3dInstance) return;
			try {
				const canvas = document.createElement('canvas');
				const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
				if (!gl) {
					throw new Error('WebGL unavailable');
				}
			} catch (err) {
				mode = '2d';
				document.getElementById('toggleBtn').innerText = 'Switch to 3D View';
				document.getElementById('graph3d').classList.add('hidden');
				document.getElementById('graph2d').classList.remove('hidden');
				init2D();
				return;
			}
			const container = document.getElementById('graph3d');
			try {
				graph3dInstance = ForceGraph3D()(container)
					.graphData({ nodes: nodesList, links: edgesList })
					.nodeColor(node => node.baseColor)
					.nodeLabel(node => \`\${node.raw.symbolName || node.id}<br/>\${node.raw.filePath}\`)
					.nodeVal(node => node.val)
					.linkColor(link => link.color)
					.linkDirectionalArrowLength(3.5)
					.linkDirectionalArrowRelPos(1)
					.onNodeClick(node => {
						const now = Date.now();
						if (last3dNodeClick.id === node.id && now - last3dNodeClick.time < 400) {
							last3dNodeClick = { id: null, time: 0 };
							vscode.postMessage({
								command: 'openFile',
								filePath: node.raw.filePath,
								startLine: node.raw.startLine
							});
							return;
						}
						last3dNodeClick = { id: node.id, time: now };
						showDetails(node);
					});

				graph3dInstance.cameraPosition({ z: 250 });
			} catch (err) {
				console.warn('[CodeGraph] 3D init failed, falling back to 2D:', err);
				graph3dInstance = null;
				mode = '2d';
				document.getElementById('toggleBtn').innerText = 'Switch to 3D View';
				document.getElementById('graph3d').classList.add('hidden');
				document.getElementById('graph2d').classList.remove('hidden');
				init2D();
				return;
			}
			requestAnimationFrame(() => {
				resizeGraphCanvas();
				applySearchFilter(getSearchQuery());
				fitGraphToView();
			});
		}

		function showDetails(node) {
			const content = document.getElementById('detailsContent');
			if (!node) {
				content.innerHTML = '<div style="color: #888888; font-style: italic;">Click a node to view its structural information.</div>';
				return;
			}
			setDetailPanelVisible(true);
			const deg = nodeDegrees[node.id] || 0;
			content.innerHTML = \`
				<div class="detail-item"><span class="detail-label">Name:</span> \${node.raw.symbolName || 'File Entry'}</div>
				<div class="detail-item"><span class="detail-label">Type:</span> \${node.raw.symbolType || 'file'}</div>
				<div class="detail-item"><span class="detail-label">Degree:</span> \${deg}</div>
				<div class="detail-item"><span class="detail-label">File:</span> <a href="#" id="openFileLink" style="color: #51a7f9; text-decoration: underline; cursor: pointer; word-break: break-all;">\${node.raw.filePath}</a></div>
				<div class="detail-item"><span class="detail-label">Line Range:</span> \${node.raw.startLine !== undefined ? node.raw.startLine + ' - ' + node.raw.endLine : 'N/A'}</div>
			\`;
			const link = document.getElementById('openFileLink');
			if (link) {
				link.addEventListener('click', (e) => {
					e.preventDefault();
					vscode.postMessage({
						command: 'openFile',
						filePath: node.raw.filePath,
						startLine: node.raw.startLine
					});
				});
			}
		}

		document.getElementById('toggleBtn').addEventListener('click', () => {
			if (mode === '2d') {
				mode = '3d';
				document.getElementById('toggleBtn').innerText = 'Switch to 2D View';
				document.getElementById('graph2d').classList.add('hidden');
				document.getElementById('graph3d').classList.remove('hidden');
				init3D();
			} else {
				mode = '2d';
				document.getElementById('toggleBtn').innerText = 'Switch to 3D View';
				document.getElementById('graph3d').classList.add('hidden');
				document.getElementById('graph2d').classList.remove('hidden');
				init2D();
			}
			scheduleGraphRelayout();
		});

		document.getElementById('closeDetailPanel')?.addEventListener('click', () => setDetailPanelVisible(false));
		document.getElementById('reopenDetailPanel')?.addEventListener('click', () => setDetailPanelVisible(true));

		document.getElementById('refreshBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'refresh' });
		});

		document.getElementById('viewScopeSelect').addEventListener('change', (e) => {
			vscode.postMessage({
				command: 'setViewOptions',
				displayScope: e.target.value,
				focusFilePath: lastHighlightFilePath || undefined
			});
		});

		document.getElementById('resetFocusBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'setViewOptions', displayScope: 'overview', clearFocus: true });
		});

		document.getElementById('searchField').addEventListener('input', (e) => {
			if (searchDebounceTimer) {
				clearTimeout(searchDebounceTimer);
			}
			const query = e.target.value;
			lastSearchQuery = '';
			searchResultIndex = 0;
			searchDebounceTimer = setTimeout(() => applySearchFilter(query), 200);
		});

		document.getElementById('searchField').addEventListener('keydown', (e) => {
			if (e.key !== 'Enter') {
				return;
			}
			e.preventDefault();
			if (searchDebounceTimer) {
				clearTimeout(searchDebounceTimer);
				searchDebounceTimer = null;
			}
			const query = e.target.value;
			activateSearchResult(query, { openFile: true, advance: e.shiftKey });
		});

		function highlightNodeByEditorPosition(filePath, lineNumber) {
			lastHighlightFilePath = filePath;
			lastHighlightLineNumber = lineNumber;

			const targetPath = normalizePath(filePath);
			const node = nodesList.find(n => {
				if (normalizePath(n.raw.filePath) !== targetPath) return false;
				if (n.raw.startLine === undefined) return false;
				const end = n.raw.endLine ?? n.raw.startLine;
				return lineNumber >= n.raw.startLine && lineNumber <= end;
			}) || nodesList.find(n => normalizePath(n.raw.filePath) === targetPath);

			if (!node) {
				if (payload.focusFilePath && normalizePath(payload.focusFilePath) !== targetPath) {
					vscode.postMessage({
						command: 'setViewOptions',
						displayScope: payload.displayScope || 'symbols',
						focusFilePath: filePath,
					});
				}
				return;
			}
			const updates = [];
			if (lastEditorHighlightId && lastEditorHighlightId !== node.id) {
				const prev = nodesList.find(n => n.id === lastEditorHighlightId);
				if (prev) {
					updates.push({ id: prev.id, color: prev.color });
				}
			}
			updates.push({
				id: node.id,
				color: { background: '#ffeb3b', border: node.color.border, highlight: node.color.highlight }
			});
			lastEditorHighlightId = node.id;
			applyNodeColorUpdates(updates);

			focusNode(node.id);
		}

		function applyPayload(nextPayload) {
			payload = nextPayload;
			rawData = payload.graph;
			nodeDegrees = payload.nodeDegrees || {};
			hubNodes = payload.hubNodes || [];
			communities = payload.communities || [];
			nodeCommunity = payload.nodeCommunity || {};
			communityColors = payload.communityColors || {};
			communityMethod = payload.communityMethod || 'components';
			graphModularity = payload.graphModularity;
			architectureReport = payload.architectureReport || '';
			fileSymbolIndex = payload.fileSymbolIndex || {};
			symbolSearchIndex = payload.symbolSearchIndex || {};
			lastSearchQuery = '';
			searchResultIndex = 0;
			destroyGraphInstances();
			buildNodeEdgeLists();
			updateViewModeBanner();
			renderHubList();
			renderCommunityList();
			document.getElementById('reportContent').textContent = architectureReport;
			if (nodesList.length === 0) {
				const total = payload.totalNodeCount || 0;
				if (total === 0) {
					showEmptyGraphMessage('No code graph indexed yet.<br/><br/>Go to <b>Settings → Rebuild Index</b>, wait for completion, then click <b>Refresh</b> here.');
				} else {
					showEmptyGraphMessage('Nothing to display in this view.<br/><br/>Select <b>Overview — file map</b> from the dropdown, or click <b>Back to full overview</b> / <b>Refresh</b>.');
				}
				return;
			}
			pickDefaultMode();
			if (mode === '2d') {
				init2D();
			} else if (typeof ForceGraph3D !== 'undefined') {
				init3D();
			} else {
				mode = '2d';
				init2D();
			}
			setTimeout(() => applySearchFilter(getSearchQuery()), 150);
			if (lastHighlightFilePath) {
				setTimeout(() => {
					highlightNodeByEditorPosition(lastHighlightFilePath, lastHighlightLineNumber);
				}, 200);
			}
		}

		function bootstrapGraph() {
			buildNodeEdgeLists();
			updateViewModeBanner();
			if (nodesList.length === 0) {
				const total = payload.totalNodeCount || 0;
				if (total === 0) {
					showEmptyGraphMessage('No code graph indexed yet.<br/><br/>Go to <b>Settings → Rebuild Index</b>, wait for completion, then click <b>Refresh</b> here.');
				} else {
					showEmptyGraphMessage('Nothing to display in this view.<br/><br/>Select <b>Overview — file map</b> from the dropdown, or click <b>Back to full overview</b> / <b>Refresh</b>.');
				}
				return;
			}
			pickDefaultMode();
			renderHubList();
			renderCommunityList();
			document.getElementById('reportContent').textContent = architectureReport;
			if (mode === '2d') {
				if (typeof vis === 'undefined') {
					document.getElementById('graph2d').innerHTML = '<div style="padding:20px;color:#888;">Graph library failed to load. Rebuild or run npm run copy-mcode-graph-vendor.</div>';
				} else {
					init2D();
				}
			} else if (typeof ForceGraph3D === 'undefined') {
				mode = '2d';
				document.getElementById('toggleBtn').innerText = 'Switch to 3D View';
				document.getElementById('graph3d').classList.add('hidden');
				document.getElementById('graph2d').classList.remove('hidden');
				init2D();
			} else {
				init3D();
			}
			const initQ = payload.initialSearchQuery || '';
			if (initQ) {
				document.getElementById('searchField').value = initQ;
				setTimeout(() => activateSearchResult(initQ, { openFile: false }), 250);
			}
			if (lastHighlightFilePath) {
				setTimeout(() => {
					highlightNodeByEditorPosition(lastHighlightFilePath, lastHighlightLineNumber);
				}, 300);
			}
		}

		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg && msg.command === 'highlightEditorPosition') {
				highlightNodeByEditorPosition(msg.filePath, msg.lineNumber);
			} else if (msg && msg.command === 'updatePayload' && msg.payload) {
				applyPayload(msg.payload);
			} else if (msg && msg.command === 'relayout') {
				scheduleGraphRelayout();
			}
		});

		bootstrapGraph();

		const graphHostEl = document.getElementById('graphHost');
		if (graphHostEl && typeof ResizeObserver !== 'undefined') {
			new ResizeObserver(() => scheduleGraphRelayout()).observe(graphHostEl);
			new ResizeObserver(() => scheduleGraphRelayout()).observe(document.documentElement);
		}
		window.addEventListener('resize', () => scheduleGraphRelayout());
		if (window.visualViewport) {
			window.visualViewport.addEventListener('resize', () => scheduleGraphRelayout());
		}
		scheduleGraphRelayout();
	</script>
</body>
</html>`;
}

registerGraphWebviewCommand();
registerWorkbenchContribution2(GraphWebviewLifecycleContribution.ID, GraphWebviewLifecycleContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(GraphWebviewLayoutContribution.ID, GraphWebviewLayoutContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(GraphWebviewRefreshContribution.ID, GraphWebviewRefreshContribution, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(GraphWebviewEditorSyncContribution.ID, GraphWebviewEditorSyncContribution, WorkbenchPhase.Eventually);
