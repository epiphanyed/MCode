/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mountFnGenerator } from '../util/mountFnGenerator.js'
import { McodeCommandBarMain } from './McodeCommandBar.js'
import { McodeSelectionHelperMain } from './McodeSelectionHelper.js'

export const mountMcodeCommandBar = mountFnGenerator(McodeCommandBarMain)

export const mountMcodeSelectionHelper = mountFnGenerator(McodeSelectionHelperMain)

