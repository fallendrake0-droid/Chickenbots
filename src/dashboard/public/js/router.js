import { parseHash } from './utils.js';
import overview from './pages/overview.js';
import { worldPage } from './pages/world.js';
import { botsPage, profilesPage, profilePage, teamPage, connectionsPage } from './pages/fleet.js';
import {
  survivalPage, inventoryPage, miningPage, excavationPage,
  woodcuttingPage, farmingPage, fishingPage, explorationPage, sleepPage
} from './pages/gameplay.js';
import { combatPage, combatTeamPage, combatGearPage, combatSuppliesPage, combatTargetsPage } from './pages/combat.js';
import { builderPage, homeBasePage, schematicsPage, buildProjectsPage, projectHistoryPage, projectDetailPage } from './pages/construction.js';
import {
  operationsOverview, builderProjectsPage, siteSurveyPage, sitePreparationPage,
  lightingPage, materialPlanningPage, warehousePage, crewAssignmentsPage, qualityPage
} from './pages/operations.js';
import { activityPage, notificationsPage, tasksPage, logsPage, settingsPage } from './pages/system.js';
import { icon } from './icons.js';
import { emptyState, pageHeader } from './ui.js';
import { esc } from './utils.js';

export const NAV_GROUPS = [
  {
    label: 'General',
    items: [
      { path: 'overview', label: 'Overview', icon: 'layout-dashboard' },
      { path: 'world', label: 'Live World', icon: 'cube' },
      { path: 'activity', label: 'Live Activity', icon: 'activity' },
      { path: 'notifications', label: 'Notifications', icon: 'bell' }
    ]
  },
  {
    label: 'Fleet',
    items: [
      { path: 'bots', label: 'All Bots', icon: 'users' },
      { path: 'team', label: 'Team Management', icon: 'crown' },
      { path: 'profiles', label: 'Bot Profiles', icon: 'user' },
      { path: 'connections', label: 'Connection Management', icon: 'wifi' }
    ]
  },
  {
    label: 'Gameplay',
    items: [
      { path: 'survival', label: 'Survival', icon: 'heart' },
      { path: 'inventory', label: 'Inventory', icon: 'package' },
      { path: 'mining', label: 'Mining', icon: 'pickaxe' },
      { path: 'excavation', label: 'Excavation', icon: 'shovel' },
      { path: 'woodcutting', label: 'Woodcutting', icon: 'axe' },
      { path: 'farming', label: 'Farming', icon: 'sprout' },
      { path: 'fishing', label: 'Fishing', icon: 'fish' },
      { path: 'exploration', label: 'Exploration', icon: 'compass' },
      { path: 'sleep', label: 'Sleep', icon: 'bed' }
    ]
  },
  {
    label: 'Combat Operations',
    items: [
      { path: 'combat', label: 'Combat Overview', icon: 'sword' },
      { path: 'combat-team', label: 'Team Fight', icon: 'users' },
      { path: 'combat-gear', label: 'Equipment', icon: 'shield' },
      { path: 'combat-supplies', label: 'Totems & Supplies', icon: 'shield-check' },
      { path: 'combat-targets', label: 'PvP & Targets', icon: 'target' }
    ]
  },
  {
    label: 'Builder Operations',
    items: [
      { path: 'operations', label: 'Builder Overview', icon: 'layout-dashboard' },
      { path: 'builder-projects', label: 'Builder Projects', icon: 'folder' },
      { path: 'site-survey', label: 'Site Survey', icon: 'map' },
      { path: 'site-prep', label: 'Site Preparation', icon: 'shovel' },
      { path: 'lighting', label: 'Lighting', icon: 'sun' },
      { path: 'material-plan', label: 'Material Planning', icon: 'package' },
      { path: 'warehouse', label: 'Storage', icon: 'archive' },
      { path: 'crew', label: 'Team Assignments', icon: 'users' },
      { path: 'qa', label: 'QA & Security', icon: 'shield' },
      { path: 'home', label: 'Home Base', icon: 'home' },
      { path: 'builder', label: 'Builder', icon: 'hammer' },
      { path: 'schematics', label: 'Schematic Library', icon: 'book-open' },
      { path: 'projects', label: 'Build Projects', icon: 'folder' },
      { path: 'history', label: 'Project History', icon: 'history' }
    ]
  },
  {
    label: 'System',
    items: [
      { path: 'tasks', label: 'Task Manager', icon: 'clipboard' },
      { path: 'logs', label: 'Logs & Diagnostics', icon: 'terminal' },
      { path: 'settings', label: 'Settings', icon: 'settings' }
    ]
  }
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label })));

function notFound(routePath) {
  return {
    key: 'not-found',
    label: 'Not found',
    group: 'Chickenbots',
    page: {
      title: 'Not found',
      render: () => `<div class="page">${pageHeader({ eyebrow: 'Chickenbots', title: 'Page not found', description: `No dashboard view matches “${routePath}”.` })}<div class="card">${emptyState('Nothing here', 'Use the navigation or the command palette to find a valid page.', 'compass', '<a class="button button--primary" href="#/">Return to overview</a>')}</div></div>`
    }
  };
}

export function resolveRoute(hash = location.hash) {
  const { segments, query } = parseHash(hash);
  const root = segments[0] || 'overview';
  const rest = segments.slice(1);
  const nav = NAV_ITEMS.find((item) => item.path === root);
  const base = { key: root, group: nav ? nav.group : 'Chickenbots', query, params: rest };
  if (!segments.length) return { ...base, page: overview, label: 'Overview', key: 'overview' };
  switch (root) {
    case 'overview': return { ...base, page: overview, label: 'Overview' };
    case 'world': return { ...base, page: worldPage, label: 'Live World' };
    case 'activity': return { ...base, page: activityPage, label: 'Live Activity' };
    case 'notifications': return { ...base, page: notificationsPage, label: 'Notifications' };
    case 'bots':
      if (!rest.length) return { ...base, page: botsPage, label: 'All Bots' };
      return { ...base, page: profilePage, label: `${rest[0]} profile`, title: rest[0] };
    case 'profiles': return { ...base, page: profilesPage, label: 'Bot Profiles' };
    case 'team': return { ...base, page: teamPage, label: 'Team Management' };
    case 'connections': return { ...base, page: connectionsPage, label: 'Connection Management' };
    case 'survival': return { ...base, page: survivalPage, label: 'Survival' };
    case 'combat': return { ...base, page: combatPage, label: 'Combat Overview' };
    case 'combat-team': return { ...base, page: combatTeamPage, label: 'Team Fight' };
    case 'combat-gear': return { ...base, page: combatGearPage, label: 'Equipment' };
    case 'combat-supplies': return { ...base, page: combatSuppliesPage, label: 'Totems & Supplies' };
    case 'combat-targets': return { ...base, page: combatTargetsPage, label: 'PvP & Targets' };
    case 'inventory': return { ...base, page: inventoryPage, label: 'Inventory' };
    case 'mining': return { ...base, page: miningPage, label: 'Mining' };
    case 'excavation': return { ...base, page: excavationPage, label: 'Excavation' };
    case 'woodcutting': return { ...base, page: woodcuttingPage, label: 'Woodcutting' };
    case 'farming': return { ...base, page: farmingPage, label: 'Farming' };
    case 'fishing': return { ...base, page: fishingPage, label: 'Fishing' };
    case 'exploration': return { ...base, page: explorationPage, label: 'Exploration' };
    case 'sleep': return { ...base, page: sleepPage, label: 'Sleep' };
    case 'operations': return { ...base, page: operationsOverview, label: 'Builder Overview' };
    case 'builder-projects': return { ...base, page: builderProjectsPage, label: 'Builder Projects' };
    case 'site-survey': return { ...base, page: siteSurveyPage, label: 'Site Survey' };
    case 'site-prep': return { ...base, page: sitePreparationPage, label: 'Site Preparation' };
    case 'lighting': return { ...base, page: lightingPage, label: 'Lighting' };
    case 'material-plan': return { ...base, page: materialPlanningPage, label: 'Material Planning' };
    case 'warehouse': return { ...base, page: warehousePage, label: 'Storage' };
    case 'crew': return { ...base, page: crewAssignmentsPage, label: 'Team Assignments' };
    case 'qa': return { ...base, page: qualityPage, label: 'QA & Security' };
    case 'home': return { ...base, page: homeBasePage, label: 'Home Base' };
    case 'builder': return { ...base, page: builderPage, label: 'Builder' };
    case 'schematics': return { ...base, page: schematicsPage, label: 'Schematic Library' };
    case 'projects':
      if (!rest.length) return { ...base, page: buildProjectsPage, label: 'Build Projects' };
      return { ...base, page: projectDetailPage, label: `Build ${rest[0]}`, params: rest };
    case 'history': return { ...base, page: projectHistoryPage, label: 'Project History' };
    case 'tasks': return { ...base, page: tasksPage, label: 'Task Manager' };
    case 'logs': return { ...base, page: logsPage, label: 'Logs & Diagnostics' };
    case 'settings': return { ...base, page: settingsPage, label: 'Settings' };
    default: return { ...notFound(segments.join('/')), params: rest, query };
  }
}

export function renderNav(activePath) {
  return NAV_GROUPS.map((group) => `
    <div class="nav-group" data-nav-group="${esc(group.label)}">
      <button class="nav-group-label" type="button" data-nav-group-toggle="${esc(group.label)}" aria-expanded="true"><span>${esc(group.label)}</span>${icon('chevron-down', 'nav-group-chevron')}</button>
      <div class="nav-group-items">
        ${group.items.map((item) => `<a class="nav-item${activePath === item.path ? ' is-active' : ''}" href="#/${item.path}" data-nav="${item.path}" data-tooltip="${esc(item.label)}"${activePath === item.path ? ' aria-current="page"' : ''}>
          <span class="nav-icon">${icon(item.icon)}</span>
          <span class="nav-item-label">${esc(item.label)}</span>
        </a>`).join('')}
      </div>
    </div>`).join('');
}

export function navMeta(path) {
  return NAV_ITEMS.find((item) => item.path === path) || { label: 'Chickenbots', group: 'Chickenbots', icon: 'compass' };
}
