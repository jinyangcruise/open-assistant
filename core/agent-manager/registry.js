/**
 * AgentRegistry - Registry for managing AI Agent adapters
 *
 * Provides a central registry for registering, discovering, and switching
 * between different AI Agents (doubao-app, chatgpt-app, web agents, etc.).
 * Persists the selected agent via electron-store.
 */

const BaseAgent = require('./base-agent');

/** @type {Map<string, BaseAgent>} */
const agents = new Map();
let selectedAgentId = 'doubao-app';
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

    // Load persisted selection
    const saved = store.get('selected_agent');
    if (saved && agents.has(saved)) {
      selectedAgentId = saved;
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

    // If this is the first registered agent, make it the default
    if (agents.size === 1) {
      selectedAgentId = agent.id;
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
   * Get the currently selected agent.
   * @returns {BaseAgent|undefined}
   */
  static getSelected() {
    return agents.get(selectedAgentId);
  }

  /**
   * Set the currently selected agent.
   * @param {string} id
   * @returns {boolean} Whether the selection was successful
   */
  static setSelected(id) {
    if (!agents.has(id)) return false;
    selectedAgentId = id;
    if (store) {
      store.set('selected_agent', id);
    }
    return true;
  }

  /**
   * Get a list of all registered agents (metadata only, not full instances).
   * @returns {Array<{id: string, name: string, type: string, endpoint: string, enabled: boolean, selected: boolean}>}
   */
  static getAll() {
    return Array.from(agents.values()).map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      endpoint: a.endpoint,
      enabled: a.enabled,
      selected: a.id === selectedAgentId,
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
