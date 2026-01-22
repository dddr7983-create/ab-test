'use strict';

import { eventSource, event_types, chat } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { promptManager, oai_settings } from '../../../openai.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { getPresetManager } from '../../../preset-manager.js';

const EXTENSION_NAME = 'ab-test';
const DB_NAME = 'ABTestSnapshots';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

let db = null;
let currentSnapshots = [];

async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
    });
}

async function saveSnapshot(snapshot) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.add(snapshot);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getAllSnapshots() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function deleteSnapshot(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function captureCurrentPromptState() {
    if (!promptManager || !promptManager.serviceSettings) {
        return null;
    }
    
    const prompts = structuredClone(promptManager.serviceSettings.prompts);
    const promptOrder = structuredClone(promptManager.serviceSettings.prompt_order);
    const presetName = oai_settings?.preset_settings_openai || 'Unknown Preset';
    
    const enabledCount = promptOrder.reduce((count, order) => {
        return count + (order.order?.filter(o => o.enabled && !prompts.find(p => p.identifier === o.identifier)?.marker)?.length || 0);
    }, 0);
    
    return {
        prompts,
        promptOrder,
        presetName,
        enabledCount,
        timestamp: Date.now(),
        name: `[${presetName}] ${new Date().toLocaleString()}`
    };
}

function applyPromptState(state) {
    if (!promptManager || !promptManager.serviceSettings || !state) {
        return false;
    }
    
    promptManager.serviceSettings.prompts = structuredClone(state.prompts);
    promptManager.serviceSettings.prompt_order = structuredClone(state.promptOrder);
    promptManager.render(false);
    
    return true;
}

async function generateWithState(state, testMessage, outputElement) {
    const originalState = captureCurrentPromptState();
    const context = getContext();
    const originalChat = structuredClone(context.chat);
    
    try {
        applyPromptState(state);
        
        if (testMessage && testMessage.trim()) {
            context.chat.push({
                name: context.name1,
                is_user: true,
                mes: testMessage.trim(),
                send_date: Date.now(),
            });
        }
        
        outputElement.innerHTML = '<div class="abtest-response abtest-streaming"></div>';
        const streamingDiv = outputElement.querySelector('.abtest-streaming');
        
        let fullText = '';
        
        const result = await context.generate('quiet', { 
            skipWIAN: false,
            force_name2: true,
            callback: (text) => {
                fullText = text;
                if (streamingDiv) {
                    streamingDiv.textContent = text;
                }
            }
        });
        
        fullText = result || fullText;
        
        if (streamingDiv) {
            streamingDiv.textContent = fullText;
        }
        
        return fullText;
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Generation error:`, error);
        return `Error: ${error.message}`;
    } finally {
        context.chat.length = 0;
        context.chat.push(...originalChat);
        
        if (originalState) {
            applyPromptState(originalState);
        }
    }
}

function getPromptDifferences(stateA, stateB) {
    const differences = [];
    
    if (!stateA || !stateB) return differences;
    
    const promptsA = new Map(stateA.prompts.map(p => [p.identifier, p]));
    const promptsB = new Map(stateB.prompts.map(p => [p.identifier, p]));
    
    for (const [id, promptA] of promptsA) {
        const promptB = promptsB.get(id);
        
        if (!promptB) {
            differences.push({ type: 'removed', identifier: id, name: promptA.name });
            continue;
        }
        
        if (promptA.content !== promptB.content) {
            differences.push({ 
                type: 'content_changed', 
                identifier: id, 
                name: promptA.name,
                contentA: promptA.content,
                contentB: promptB.content
            });
        }
        
        const orderA = stateA.promptOrder.find(o => o.order?.some(e => e.identifier === id));
        const orderB = stateB.promptOrder.find(o => o.order?.some(e => e.identifier === id));
        
        const enabledA = orderA?.order?.find(e => e.identifier === id)?.enabled;
        const enabledB = orderB?.order?.find(e => e.identifier === id)?.enabled;
        
        if (enabledA !== enabledB) {
            differences.push({
                type: 'enabled_changed',
                identifier: id,
                name: promptA.name,
                enabledA,
                enabledB
            });
        }
    }
    
    for (const [id, promptB] of promptsB) {
        if (!promptsA.has(id)) {
            differences.push({ type: 'added', identifier: id, name: promptB.name });
        }
    }
    
    return differences;
}

function createSnapshotCard(snapshot, index, isSelected = false) {
    const selectedClass = isSelected ? 'abtest-snapshot-selected' : '';
    const presetBadge = snapshot.presetName ? `<span class="abtest-preset-badge">${escapeHtml(snapshot.presetName)}</span>` : '';
    return `
        <div class="abtest-snapshot-card ${selectedClass}" data-id="${snapshot.id}" data-index="${index}">
            <div class="abtest-snapshot-header">
                <span class="abtest-snapshot-name">${escapeHtml(snapshot.name)}</span>
                <div class="abtest-snapshot-actions">
                    <button class="abtest-btn-icon abtest-view-btn" data-id="${snapshot.id}" title="View prompts">
                        <i class="fa-solid fa-eye"></i>
                    </button>
                    <button class="abtest-btn-icon abtest-select-btn" data-slot="${index}" title="Select for comparison">
                        <i class="fa-solid fa-check"></i>
                    </button>
                    <button class="abtest-btn-icon abtest-delete-btn" data-id="${snapshot.id}" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="abtest-snapshot-meta">
                ${presetBadge}
                <span>${new Date(snapshot.timestamp).toLocaleString()}</span>
            </div>
            <div class="abtest-snapshot-preview">
                ${snapshot.prompts.filter(p => !p.marker && !p.system_prompt).length} prompts
            </div>
        </div>
    `;
}

function renderDifferences(differences) {
    if (differences.length === 0) {
        return '<div class="abtest-no-diff">No differences found</div>';
    }
    
    return differences.map((diff, index) => {
        let icon, label, detail = '', colorClass = '', clickable = false;
        
        switch (diff.type) {
            case 'removed':
                icon = 'fa-minus-circle';
                label = diff.name;
                colorClass = 'abtest-diff-removed';
                break;
            case 'added':
                icon = 'fa-plus-circle';
                label = diff.name;
                colorClass = 'abtest-diff-added';
                break;
            case 'content_changed':
                icon = 'fa-edit';
                label = diff.name;
                colorClass = 'abtest-diff-modified abtest-diff-clickable';
                clickable = true;
                const previewA = (diff.contentA || '').substring(0, 80);
                const previewB = (diff.contentB || '').substring(0, 80);
                detail = `
                    <div class="abtest-diff-preview">
                        <span class="abtest-diff-preview-text">${escapeHtml(previewA)}${diff.contentA?.length > 80 ? '...' : ''}</span>
                        <i class="fa-solid fa-expand abtest-diff-expand-icon"></i>
                    </div>
                `;
                break;
            case 'enabled_changed':
                icon = 'fa-toggle-on';
                label = diff.name;
                colorClass = diff.enabledB ? 'abtest-diff-added' : 'abtest-diff-removed';
                detail = `<div class="abtest-diff-detail"><span class="abtest-tag-off">${diff.enabledA ? 'ON' : 'OFF'}</span> → <span class="abtest-tag-on">${diff.enabledB ? 'ON' : 'OFF'}</span></div>`;
                break;
            default:
                icon = 'fa-question';
                label = diff.type;
        }
        
        const dataAttr = clickable ? `data-diff-index="${index}"` : '';
        
        return `
            <div class="abtest-diff-item ${colorClass}" ${dataAttr}>
                <div class="abtest-diff-header">
                    <i class="fa-solid ${icon}"></i>
                    <span class="abtest-diff-name">${escapeHtml(label)}</span>
                    ${clickable ? '<span class="abtest-diff-hint">Click to compare</span>' : ''}
                </div>
                ${detail}
            </div>
        `;
    }).join('');
}

function getAvailablePresets() {
    try {
        const pm = getPresetManager('openai');
        if (pm) {
            return pm.getAllPresets();
        }
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to get presets:`, error);
    }
    return [];
}

function getCurrentPresetName() {
    try {
        const pm = getPresetManager('openai');
        if (pm) {
            return pm.getSelectedPresetName();
        }
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to get current preset:`, error);
    }
    return oai_settings?.preset_settings_openai || 'Unknown';
}

async function switchPreset(presetName) {
    try {
        const pm = getPresetManager('openai');
        if (pm) {
            const presetValue = pm.findPreset(presetName);
            if (presetValue !== undefined) {
                await pm.selectPreset(presetValue);
                return true;
            }
        }
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to switch preset:`, error);
    }
    return false;
}

async function showMainModal() {
    await loadSnapshots();
    
    const currentState = captureCurrentPromptState();
    const presets = getAvailablePresets();
    const currentPreset = getCurrentPresetName();
    
    const presetOptions = presets.map(p => 
        `<option value="${escapeHtml(p)}" ${p === currentPreset ? 'selected' : ''}>${escapeHtml(p)}</option>`
    ).join('');
    
    const modalContent = `
        <div class="abtest-modal">
            <div class="abtest-header">
                <span class="abtest-title">A/B Test</span>
            </div>
            
            <div class="abtest-body">
                <div class="abtest-section">
                    <div class="abtest-section-header">
                        <span class="abtest-section-title">Quick Preset Switch</span>
                    </div>
                    <div class="abtest-preset-switch">
                        <select class="abtest-select" id="abtest-preset-select">
                            ${presetOptions}
                        </select>
                        <button class="abtest-btn abtest-btn-secondary" id="abtest-apply-preset">
                            <i class="fa-solid fa-sync"></i> Apply
                        </button>
                        <button class="abtest-btn abtest-btn-primary" id="abtest-save-after-switch">
                            <i class="fa-solid fa-camera"></i> Apply & Save
                        </button>
                    </div>
                    <div class="abtest-preset-current">
                        Current: <span id="abtest-current-preset-name">${escapeHtml(currentPreset)}</span>
                    </div>
                </div>
                
                <div class="abtest-section">
                    <div class="abtest-section-header">
                        <span class="abtest-section-title">Snapshots</span>
                        <button class="abtest-btn abtest-btn-primary" id="abtest-save-snapshot">
                            <i class="fa-solid fa-camera"></i> Save Current
                        </button>
                    </div>
                    <div class="abtest-snapshots-list" id="abtest-snapshots-list">
                        ${currentSnapshots.length === 0 
                            ? '<div class="abtest-empty">No snapshots saved yet</div>'
                            : currentSnapshots.map((s, i) => createSnapshotCard(s, i)).join('')
                        }
                    </div>
                </div>
                
                <div class="abtest-section">
                    <div class="abtest-section-header">
                        <span class="abtest-section-title">Compare</span>
                    </div>
                    <div class="abtest-compare-slots">
                        <div class="abtest-slot" id="abtest-slot-a">
                            <div class="abtest-slot-label">A</div>
                            <div class="abtest-slot-content" id="abtest-slot-a-content">
                                <span class="abtest-slot-empty">Select a snapshot</span>
                            </div>
                        </div>
                        <div class="abtest-vs">VS</div>
                        <div class="abtest-slot" id="abtest-slot-b">
                            <div class="abtest-slot-label">B</div>
                            <div class="abtest-slot-content" id="abtest-slot-b-content">
                                <span class="abtest-slot-empty">Select a snapshot or use current</span>
                            </div>
                            <button class="abtest-btn abtest-btn-secondary abtest-use-current" id="abtest-use-current">
                                Use Current Config
                            </button>
                        </div>
                    </div>
                    
                    <div class="abtest-diff-section" id="abtest-diff-section" style="display: none;">
                        <div class="abtest-section-title">Differences</div>
                        <div class="abtest-diff-list" id="abtest-diff-list"></div>
                    </div>
                </div>
                
                <div class="abtest-section">
                    <div class="abtest-section-header">
                        <span class="abtest-section-title">Test Message</span>
                    </div>
                    <textarea class="abtest-input" id="abtest-input" placeholder="Enter test message (optional - uses current chat if empty)..."></textarea>
                    <button class="abtest-btn abtest-btn-primary abtest-run-btn" id="abtest-run-test">
                        <i class="fa-solid fa-play"></i> Run A/B Test
                    </button>
                </div>
                
                <div class="abtest-results" id="abtest-results" style="display: none;">
                    <div class="abtest-section-header">
                        <span class="abtest-section-title">Results</span>
                    </div>
                    <div class="abtest-results-grid">
                        <div class="abtest-result-panel">
                            <div class="abtest-result-label">Response A</div>
                            <div class="abtest-result-content" id="abtest-result-a"></div>
                        </div>
                        <div class="abtest-result-panel">
                            <div class="abtest-result-label">Response B</div>
                            <div class="abtest-result-content" id="abtest-result-b"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    const popup = new Popup(modalContent, POPUP_TYPE.TEXT, '', { 
        large: true, 
        wide: true,
        okButton: 'Close',
        cancelButton: false
    });
    
    popup.show().then(() => {});
    
    setTimeout(() => {
        setupModalEventHandlers(currentState);
    }, 100);
}

let selectedSlotA = null;
let selectedSlotB = null;

async function loadSnapshots() {
    try {
        currentSnapshots = await getAllSnapshots();
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to load snapshots:`, error);
        currentSnapshots = [];
    }
}

function setupModalEventHandlers(currentState) {
    const saveBtn = document.getElementById('abtest-save-snapshot');
    const useCurrentBtn = document.getElementById('abtest-use-current');
    const runTestBtn = document.getElementById('abtest-run-test');
    const snapshotsList = document.getElementById('abtest-snapshots-list');
    const presetSelect = document.getElementById('abtest-preset-select');
    const applyPresetBtn = document.getElementById('abtest-apply-preset');
    const saveAfterSwitchBtn = document.getElementById('abtest-save-after-switch');
    const currentPresetDisplay = document.getElementById('abtest-current-preset-name');
    
    applyPresetBtn?.addEventListener('click', async () => {
        const selectedPreset = presetSelect?.value;
        if (selectedPreset) {
            applyPresetBtn.disabled = true;
            applyPresetBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            
            const success = await switchPreset(selectedPreset);
            
            if (success) {
                toastr.success(`Switched to preset: ${selectedPreset}`);
                if (currentPresetDisplay) {
                    currentPresetDisplay.textContent = selectedPreset;
                }
                currentState = captureCurrentPromptState();
            } else {
                toastr.error('Failed to switch preset');
            }
            
            applyPresetBtn.disabled = false;
            applyPresetBtn.innerHTML = '<i class="fa-solid fa-sync"></i> Apply';
        }
    });
    
    saveAfterSwitchBtn?.addEventListener('click', async () => {
        const selectedPreset = presetSelect?.value;
        if (selectedPreset) {
            saveAfterSwitchBtn.disabled = true;
            saveAfterSwitchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            
            const success = await switchPreset(selectedPreset);
            
            if (success) {
                if (currentPresetDisplay) {
                    currentPresetDisplay.textContent = selectedPreset;
                }
                
                await new Promise(resolve => setTimeout(resolve, 100));
                
                const state = captureCurrentPromptState();
                if (state) {
                    const name = await promptForName();
                    if (name) {
                        state.name = name;
                        await saveSnapshot(state);
                        await loadSnapshots();
                        refreshSnapshotsList();
                        toastr.success(`Switched to ${selectedPreset} and saved snapshot`);
                    }
                }
                currentState = captureCurrentPromptState();
            } else {
                toastr.error('Failed to switch preset');
            }
            
            saveAfterSwitchBtn.disabled = false;
            saveAfterSwitchBtn.innerHTML = '<i class="fa-solid fa-camera"></i> Apply & Save';
        }
    });
    
    saveBtn?.addEventListener('click', async () => {
        const state = captureCurrentPromptState();
        if (state) {
            const name = await promptForName();
            if (name) {
                state.name = name;
                await saveSnapshot(state);
                await loadSnapshots();
                refreshSnapshotsList();
                toastr.success('Snapshot saved');
            }
        }
    });
    
    useCurrentBtn?.addEventListener('click', () => {
        selectedSlotB = { ...currentState, name: 'Current Config' };
        updateSlotDisplay('b', selectedSlotB);
        updateDiffDisplay();
    });
    
    runTestBtn?.addEventListener('click', async () => {
        await runABTest();
    });
    
    snapshotsList?.addEventListener('click', async (e) => {
        const selectBtn = e.target.closest('.abtest-select-btn');
        const deleteBtn = e.target.closest('.abtest-delete-btn');
        const viewBtn = e.target.closest('.abtest-view-btn');
        const card = e.target.closest('.abtest-snapshot-card');
        
        if (viewBtn) {
            const id = parseInt(viewBtn.dataset.id);
            const snapshot = currentSnapshots.find(s => s.id === id);
            if (snapshot) {
                showPromptViewer(snapshot);
            }
            return;
        }
        
        if (deleteBtn) {
            const id = parseInt(deleteBtn.dataset.id);
            if (confirm('Delete this snapshot?')) {
                await deleteSnapshot(id);
                await loadSnapshots();
                refreshSnapshotsList();
                
                if (selectedSlotA?.id === id) {
                    selectedSlotA = null;
                    updateSlotDisplay('a', null);
                }
                if (selectedSlotB?.id === id) {
                    selectedSlotB = null;
                    updateSlotDisplay('b', null);
                }
                updateDiffDisplay();
            }
            return;
        }
        
        if (selectBtn || card) {
            const cardEl = selectBtn ? selectBtn.closest('.abtest-snapshot-card') : card;
            const id = parseInt(cardEl.dataset.id);
            const snapshot = currentSnapshots.find(s => s.id === id);
            
            if (!snapshot) return;
            
            if (!selectedSlotA || (selectedSlotA && selectedSlotB)) {
                selectedSlotA = snapshot;
                selectedSlotB = null;
                updateSlotDisplay('a', selectedSlotA);
                updateSlotDisplay('b', null);
            } else {
                selectedSlotB = snapshot;
                updateSlotDisplay('b', selectedSlotB);
            }
            
            updateDiffDisplay();
            refreshSnapshotsList();
        }
    });
}

function refreshSnapshotsList() {
    const list = document.getElementById('abtest-snapshots-list');
    if (!list) return;
    
    if (currentSnapshots.length === 0) {
        list.innerHTML = '<div class="abtest-empty">No snapshots saved yet</div>';
        return;
    }
    
    list.innerHTML = currentSnapshots.map((s, i) => {
        const isSelectedA = selectedSlotA?.id === s.id;
        const isSelectedB = selectedSlotB?.id === s.id;
        return createSnapshotCard(s, i, isSelectedA || isSelectedB);
    }).join('');
}

function updateSlotDisplay(slot, snapshot) {
    const content = document.getElementById(`abtest-slot-${slot}-content`);
    if (!content) return;
    
    if (!snapshot) {
        content.innerHTML = `<span class="abtest-slot-empty">Select a snapshot${slot === 'b' ? ' or use current' : ''}</span>`;
    } else {
        const presetInfo = snapshot.presetName ? `<span class="abtest-slot-preset">${escapeHtml(snapshot.presetName)}</span>` : '';
        content.innerHTML = `
            <div class="abtest-slot-selected">
                <i class="fa-solid fa-camera"></i>
                <div class="abtest-slot-info">
                    <span class="abtest-slot-name">${escapeHtml(snapshot.name)}</span>
                    ${presetInfo}
                </div>
            </div>
        `;
    }
}

function showPromptViewer(snapshot) {
    const activePrompts = [];
    
    for (const orderEntry of snapshot.promptOrder) {
        if (!orderEntry.order) continue;
        
        for (const item of orderEntry.order) {
            const prompt = snapshot.prompts.find(p => p.identifier === item.identifier);
            if (prompt && !prompt.marker) {
                activePrompts.push({
                    ...prompt,
                    enabled: item.enabled
                });
            }
        }
    }
    
    const promptsHtml = activePrompts.map(p => `
        <div class="abtest-prompt-item ${p.enabled ? '' : 'abtest-prompt-disabled'}">
            <div class="abtest-prompt-header">
                <span class="abtest-prompt-name">${escapeHtml(p.name || p.identifier)}</span>
                <span class="abtest-prompt-status">${p.enabled ? 'ON' : 'OFF'}</span>
            </div>
            <div class="abtest-prompt-role">${p.role || 'system'}</div>
            <div class="abtest-prompt-content">${escapeHtml(p.content || '(empty)')}</div>
        </div>
    `).join('');
    
    const viewerContent = `
        <div class="abtest-viewer">
            <div class="abtest-viewer-header">
                <span class="abtest-viewer-title">${escapeHtml(snapshot.name)}</span>
                <span class="abtest-viewer-preset">${escapeHtml(snapshot.presetName || 'Unknown')}</span>
            </div>
            <div class="abtest-viewer-body">
                ${promptsHtml || '<div class="abtest-empty">No prompts found</div>'}
            </div>
        </div>
    `;
    
    const popup = new Popup(viewerContent, POPUP_TYPE.TEXT, '', {
        large: true,
        wide: true,
        okButton: 'Close',
        cancelButton: false
    });
    
    popup.show();
}

let currentDifferences = [];

function updateDiffDisplay() {
    const diffSection = document.getElementById('abtest-diff-section');
    const diffList = document.getElementById('abtest-diff-list');
    
    if (!diffSection || !diffList) return;
    
    if (selectedSlotA && selectedSlotB) {
        currentDifferences = getPromptDifferences(selectedSlotA, selectedSlotB);
        diffList.innerHTML = renderDifferences(currentDifferences);
        diffSection.style.display = 'block';
        
        diffList.querySelectorAll('.abtest-diff-clickable').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.diffIndex);
                if (!isNaN(index) && currentDifferences[index]) {
                    showDiffCompareModal(currentDifferences[index]);
                }
            });
        });
    } else {
        diffSection.style.display = 'none';
        currentDifferences = [];
    }
}

function computeLineDiff(textA, textB) {
    const linesA = textA.split('\n');
    const linesB = textB.split('\n');
    const maxLen = Math.max(linesA.length, linesB.length);
    
    const resultA = [];
    const resultB = [];
    
    for (let i = 0; i < maxLen; i++) {
        const lineA = linesA[i];
        const lineB = linesB[i];
        
        if (lineA === undefined) {
            resultA.push({ text: '', type: 'empty' });
            resultB.push({ text: lineB, type: 'added' });
        } else if (lineB === undefined) {
            resultA.push({ text: lineA, type: 'removed' });
            resultB.push({ text: '', type: 'empty' });
        } else if (lineA === lineB) {
            resultA.push({ text: lineA, type: 'same' });
            resultB.push({ text: lineB, type: 'same' });
        } else {
            resultA.push({ text: lineA, type: 'changed', wordDiff: computeWordDiff(lineA, lineB).diffA });
            resultB.push({ text: lineB, type: 'changed', wordDiff: computeWordDiff(lineA, lineB).diffB });
        }
    }
    
    return { resultA, resultB };
}

function computeWordDiff(lineA, lineB) {
    const wordsA = lineA.split(/(\s+)/);
    const wordsB = lineB.split(/(\s+)/);
    
    const diffA = [];
    const diffB = [];
    
    const maxLen = Math.max(wordsA.length, wordsB.length);
    
    for (let i = 0; i < maxLen; i++) {
        const wordA = wordsA[i];
        const wordB = wordsB[i];
        
        if (wordA === undefined) {
            diffB.push({ text: wordB, type: 'added' });
        } else if (wordB === undefined) {
            diffA.push({ text: wordA, type: 'removed' });
        } else if (wordA === wordB) {
            diffA.push({ text: wordA, type: 'same' });
            diffB.push({ text: wordB, type: 'same' });
        } else {
            diffA.push({ text: wordA, type: 'removed' });
            diffB.push({ text: wordB, type: 'added' });
        }
    }
    
    return { diffA, diffB };
}

function renderDiffLine(lineData) {
    if (lineData.type === 'empty') {
        return '<div class="abtest-diff-line abtest-diff-line-empty">&nbsp;</div>';
    }
    
    if (lineData.type === 'same') {
        return `<div class="abtest-diff-line">${escapeHtml(lineData.text)}</div>`;
    }
    
    if (lineData.wordDiff) {
        const html = lineData.wordDiff.map(w => {
            if (w.type === 'same') {
                return escapeHtml(w.text);
            } else if (w.type === 'added') {
                return `<span class="abtest-word-added">${escapeHtml(w.text)}</span>`;
            } else if (w.type === 'removed') {
                return `<span class="abtest-word-removed">${escapeHtml(w.text)}</span>`;
            }
            return escapeHtml(w.text);
        }).join('');
        return `<div class="abtest-diff-line abtest-diff-line-${lineData.type}">${html}</div>`;
    }
    
    const className = lineData.type === 'added' ? 'abtest-diff-line-added' : 
                      lineData.type === 'removed' ? 'abtest-diff-line-removed' : '';
    return `<div class="abtest-diff-line ${className}">${escapeHtml(lineData.text)}</div>`;
}

function showDiffCompareModal(diff) {
    const contentA = diff.contentA || '(empty)';
    const contentB = diff.contentB || '(empty)';
    
    const { resultA, resultB } = computeLineDiff(contentA, contentB);
    
    const htmlA = resultA.map(renderDiffLine).join('');
    const htmlB = resultB.map(renderDiffLine).join('');
    
    const modalContent = `
        <div class="abtest-compare-modal">
            <div class="abtest-compare-header">
                <span class="abtest-compare-title">${escapeHtml(diff.name)}</span>
                <span class="abtest-compare-subtitle">Content Comparison (changes highlighted)</span>
            </div>
            <div class="abtest-compare-body">
                <div class="abtest-compare-panel abtest-compare-panel-a">
                    <div class="abtest-compare-panel-header">
                        <span class="abtest-compare-panel-label">A</span>
                        <span class="abtest-compare-panel-name">${escapeHtml(selectedSlotA?.name || 'Snapshot A')}</span>
                    </div>
                    <div class="abtest-compare-panel-content abtest-diff-content">${htmlA}</div>
                </div>
                <div class="abtest-compare-panel abtest-compare-panel-b">
                    <div class="abtest-compare-panel-header">
                        <span class="abtest-compare-panel-label">B</span>
                        <span class="abtest-compare-panel-name">${escapeHtml(selectedSlotB?.name || 'Snapshot B')}</span>
                    </div>
                    <div class="abtest-compare-panel-content abtest-diff-content">${htmlB}</div>
                </div>
            </div>
        </div>
    `;
    
    const popup = new Popup(modalContent, POPUP_TYPE.TEXT, '', {
        large: true,
        wide: true,
        okButton: 'Close',
        cancelButton: false
    });
    
    popup.show();
}

async function promptForName() {
    const result = await Popup.show.input('Snapshot Name', 'Enter a name for this snapshot:', `Snapshot ${new Date().toLocaleString()}`);
    return result;
}

async function runABTest() {
    if (!selectedSlotA) {
        toastr.warning('Please select at least one snapshot for slot A');
        return;
    }
    
    const stateB = selectedSlotB || captureCurrentPromptState();
    if (!stateB) {
        toastr.warning('Please select or use current config for slot B');
        return;
    }
    
    const context = getContext();
    if (!context.chat || context.chat.length === 0) {
        toastr.warning('No chat history available');
        return;
    }
    
    const testMessage = document.getElementById('abtest-input')?.value?.trim() || '';
    
    const resultsSection = document.getElementById('abtest-results');
    const resultA = document.getElementById('abtest-result-a');
    const resultB = document.getElementById('abtest-result-b');
    const runBtn = document.getElementById('abtest-run-test');
    
    if (!resultsSection || !resultA || !resultB) return;
    
    resultsSection.style.display = 'block';
    resultA.innerHTML = '<div class="abtest-loading"><i class="fa-solid fa-spinner fa-spin"></i> Generating...</div>';
    resultB.innerHTML = '<div class="abtest-loading"><i class="fa-solid fa-spinner fa-spin"></i> Generating...</div>';
    
    if (runBtn) {
        runBtn.disabled = true;
        runBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running...';
    }
    
    try {
        const responseA = await generateWithState(selectedSlotA, testMessage, resultA);
        const responseB = await generateWithState(stateB, testMessage, resultB);
        
        resultA.innerHTML = `<div class="abtest-response">${escapeHtml(responseA) || '<em>No response</em>'}</div>`;
        resultB.innerHTML = `<div class="abtest-response">${escapeHtml(responseB) || '<em>No response</em>'}</div>`;
        
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] A/B test error:`, error);
        toastr.error('Failed to run A/B test');
        resultA.innerHTML = '<div class="abtest-error">Error generating response</div>';
        resultB.innerHTML = '<div class="abtest-error">Error generating response</div>';
    } finally {
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.innerHTML = '<i class="fa-solid fa-play"></i> Run A/B Test';
        }
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function addMenuButton() {
    const extensionsMenu = document.getElementById('extensionsMenu');
    if (!extensionsMenu) {
        setTimeout(addMenuButton, 1000);
        return;
    }
    
    const existingBtn = document.getElementById('abtest-menu-btn');
    if (existingBtn) return;
    
    const menuItem = document.createElement('div');
    menuItem.id = 'abtest-menu-btn';
    menuItem.className = 'list-group-item flex-container flexGap5';
    menuItem.innerHTML = `
        <i class="fa-solid fa-flask extensionsMenuExtensionButton"></i>
        A/B Test
    `;
    menuItem.addEventListener('click', () => {
        showMainModal();
    });
    
    extensionsMenu.appendChild(menuItem);
}

async function init() {
    try {
        await initDB();
        addMenuButton();
        
        console.log(`[${EXTENSION_NAME}] Extension loaded`);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to initialize:`, error);
    }
}

eventSource.on(event_types.APP_READY, init);
