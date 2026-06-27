/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ModelSelection, ProviderName } from './mcodeSettingsTypes.js';

export type ModelIntentKind = 'fast' | 'code' | 'reasoning';

export interface ModelIntentRouterConfig {
	enabled: boolean;
	fastModel: ModelSelection | null;
	reasoningModel: ModelSelection | null;
}

const FAST_INTENT_PATTERNS: RegExp[] = [
	/^(?:解释|说明|翻译|起名|命名|这是什么|啥意思|what\s+is|what's|how\s+to\s+use|explain|translate|rename|name\s+this)/i,
	/^(?:用一句话|简单说说|简要|briefly|in\s+short)/i,
];

const REASONING_INTENT_PATTERNS: RegExp[] = [
	/\b(?:error|failed|crash|bug|exception|stack\s+trace|deadlock|memory\s+leak)\b/i,
	/(?:报错|失败|崩溃|死锁|内存泄漏|异常|为什么.*不工作|why.*(?:fail|not\s+work))/i,
	/\b(?:debug|diagnose|root\s+cause|troubleshoot)\b/i,
];

/** Lightweight local intent classifier (Phase 9). */
export function classifyQueryIntent(query: string): ModelIntentKind {
	const trimmed = query.trim();
	if (trimmed.length === 0) {
		return 'code';
	}
	if (REASONING_INTENT_PATTERNS.some(p => p.test(trimmed))) {
		return 'reasoning';
	}
	if (FAST_INTENT_PATTERNS.some(p => p.test(trimmed))) {
		return 'fast';
	}
	return 'code';
}

export interface ModelIntentRouteResult {
	model: ModelSelection;
	intent: ModelIntentKind;
	routed: boolean;
}

export function routeModelByIntent(
	query: string,
	defaultModel: ModelSelection,
	config: ModelIntentRouterConfig,
): ModelIntentRouteResult {
	if (!config.enabled) {
		return { model: defaultModel, intent: 'code', routed: false };
	}

	const intent = classifyQueryIntent(query);
	if (intent === 'fast' && config.fastModel) {
		return { model: config.fastModel, intent, routed: true };
	}
	if (intent === 'reasoning' && config.reasoningModel) {
		return { model: config.reasoningModel, intent, routed: true };
	}
	return { model: defaultModel, intent, routed: false };
}

export function parseModelRouterSelection(
	providerName: string,
	modelName: string,
): ModelSelection | null {
	if (!providerName?.trim() || !modelName?.trim()) {
		return null;
	}
	return { providerName: providerName as ProviderName, modelName: modelName.trim() };
}

export function modelRouterSelectionFromSettings(settings: {
	modelIntentRoutingEnabled?: boolean;
	modelRouterFastProvider?: string;
	modelRouterFastModel?: string;
	modelRouterReasoningProvider?: string;
	modelRouterReasoningModel?: string;
}): ModelIntentRouterConfig {
	return {
		enabled: settings.modelIntentRoutingEnabled ?? false,
		fastModel: parseModelRouterSelection(
			settings.modelRouterFastProvider ?? '',
			settings.modelRouterFastModel ?? '',
		),
		reasoningModel: parseModelRouterSelection(
			settings.modelRouterReasoningProvider ?? '',
			settings.modelRouterReasoningModel ?? '',
		),
	};
}
