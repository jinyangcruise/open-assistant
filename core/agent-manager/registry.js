/**
 * AgentRegistry - Registry for managing AI Agent adapters
 *
 * Provides a central registry for registering, discovering, and selecting
 * between different AI Agents (doubao-app, chatgpt-app, web agents, etc.).
 * Supports multi-select: multiple agents can be selected simultaneously.
 * Each agent is triggered individually by its own shortcut key.
 * Persists the selected agent IDs via electron-store.
 */

const BaseAgent = require('./base-agent');

/** @type {Map<string, BaseAgent>} */
const agents = new Map();
let selectedAgentIds = ['doubao-app'];
/** @type {import('electron-store')|null} */
let store = null;

class AgentRegistry {
  /**
   * Initialize the registry with an electron-store instance.
   * Must be called before using the registry.
   * @param {Object} electronStore - electron-store instance
   */
  static init(electronStore) {
    store = electronStore;

    // Load persisted selection (array of IDs)
    const saved = store.get('selected_agents');
    if (Array.isArray(saved) && saved.length > 0) {
      const valid = saved.filter(id => agents.has(id));
      if (valid.length > 0) {
        selectedAgentIds = valid;
      }
    }
  }

  /**
   * Register an agent adapter.
   * @param {BaseAgent} agent - Agent instance (must extend BaseAgent)
   */
  static register(agent) {
    if (!(agent instanceof BaseAgent)) {
      throw new Error('Agent must extend BaseAgent');
    }
    agents.set(agent.id, agent);

    // If this is the first registered agent, make it selected by default
    if (agents.size === 1) {
      if (!selectedAgentIds.includes(agent.id)) {
        selectedAgentIds.push(agent.id);
      }
    }
  }

  /**
   * Get an agent by ID.
   * @param {string} id
   * @returns {BaseAgent|undefined}
   */
  static getAgent(id) {
    return agents.get(id);
  }

  /**
   * Get the first selected agent (for backward compatibility).
   * @returns {BaseAgent|undefined}
   */
  static getSelected() {
    return agents.get(selectedAgentIds[0]);
  }

  /**
   * Get all selected agent IDs.
   * @returns {string[]}
   */
  static getSelectedIds() {
    return [...selectedAgentIds];
  }

  /**
   * Toggle an agent's selected state.
   * If the agent becomes selected and it was not previously, it is added.
   * If it was selected, it is removed.
   * Ensures at least one agent remains selected.
   * @param {string} id
   * @returns {boolean} Whether the agent is now selected
   */
  static toggleSelected(id) {
    if (!agents.has(id)) return false;
    const idx = selectedAgentIds.indexOf(id);
    if (idx >= 0) {
      // Don't deselect if it's the last one
      if (selectedAgentIds.length > 1) {
        selectedAgentIds.splice(idx, 1);
      }
    } else {
      selectedAgentIds.push(id);
    }
    if (store) {
      store.set('selected_agents', selectedAgentIds);
    }
    return selectedAgentIds.includes(id);
  }

  /**
   * Set the selected agents to an exact list of IDs.
   * @param {string[]} ids
   * @returns {boolean} Whether the selection was updated
   */
  static setSelectedAgents(ids) {
    const valid = ids.filter(id => agents.has(id));
    if (valid.length === 0) return false;
    selectedAgentIds = valid;
    if (store) {
      store.set('selected_agents', selectedAgentIds);
    }
    return true;
  }

  /**
   * Get a list of all registered agents (metadata only, not full instances).
   * @returns {Array<{id: string, name: string, type: string, endpoint: string, enabled: boolean, installPath: string, shortcut: string, selected: boolean}>}
   */
  static getAll() {
    return Array.from(agents.values()).map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      endpoint: a.endpoint,
      enabled: a.enabled,
      installPath: a.installPath,
      shortcut: store ? store.get(`agents.${a.id}.shortcut`) || '' : '',
      selected: selectedAgentIds.includes(a.id),
    }));
  }

  /**
   * Test connection for a specific agent.
   * @param {string} id
   * @returns {Promise<{success: boolean, error?: string, title?: string}>}
   */
  static async testConnection(id) {
    const agent = agents.get(id);
    if (!agent) return { success: false, error: 'Agent not found' };
    return await agent.testConnection();
  }

  /**
   * Get connection status for all registered agents.
   * @returns {Promise<Array<{id: string, name: string, connected: boolean, error?: string}>>}
   */
  static async getAllConnectionStatus() {
    const results = [];
    for (const [, agent] of agents) {
      const status = await agent.testConnection();
      results.push({
        id: agent.id,
        name: agent.name,
        connected: status.success,
        error: status.error,
      });
    }
    return results;
  }
}

module.exports = AgentRegistry;
