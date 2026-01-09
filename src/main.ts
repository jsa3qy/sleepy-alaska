import L from 'leaflet';
import * as yaml from 'js-yaml';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';
import 'leaflet-routing-machine';
import 'leaflet-routing-machine/dist/leaflet-routing-machine.css';

// Supabase configuration - replace with your project values
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

let supabase: SupabaseClient | null = null;

// Initialize Supabase if configured
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// GPX parsing - fetches local GPX files and extracts coordinates
async function fetchAndParseGPX(url: string): Promise<[number, number][]> {
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const gpxText = await response.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxText, 'text/xml');
    const coordinates: [number, number][] = [];

    let trackPoints = doc.querySelectorAll('trkpt');
    if (trackPoints.length === 0) trackPoints = doc.querySelectorAll('rtept');
    if (trackPoints.length === 0) trackPoints = doc.querySelectorAll('wpt');

    trackPoints.forEach(point => {
      const lat = parseFloat(point.getAttribute('lat') || '0');
      const lng = parseFloat(point.getAttribute('lon') || '0');
      if (lat !== 0 && lng !== 0) {
        coordinates.push([lat, lng]);
      }
    });

    return coordinates;
  } catch (error) {
    console.error('Error fetching/parsing GPX:', error);
    return [];
  }
}

// Fix for default marker icons in Leaflet with bundlers
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface Category {
  id: string;
  name: string;
  color: string;
}

interface Pin {
  id: string;               // Database ID for voting
  name: string;
  coordinates: [number, number];
  description: string;
  category: string;
  region?: string;          // Region name for grouping
  votable?: boolean;        // Override to make pin votable/non-votable
  link?: string;
  maps_link?: string;
  extended_description?: string;
  cost?: string;
  tips?: string;
  photos?: string[];
  distance?: number;        // in miles (for hikes)
  elevation_gain?: number;  // in feet (for hikes)
  gpx?: string;             // GPX filename for hike routes
}

interface MapConfig {
  map: {
    center: [number, number];
    zoom: number;
  };
  categories: Category[];
  pins: Pin[];
}

// Database row types from Supabase
interface DbCategory {
  id: string;
  name: string;
  color: string;
}

interface DbPin {
  id: string;
  name: string;
  lat: number;
  lng: number;
  description: string;
  category_id: string;
  link: string | null;
  maps_link: string | null;
  extended_description: string | null;
  cost: string | null;
  tips: string | null;
  photos: string[] | null;
  distance: number | null;
  elevation_gain: number | null;
  gpx: string | null;
}

interface DbMapConfig {
  center_lat: number;
  center_lng: number;
  zoom: number;
}

interface DbRegion {
  id: string;
  name: string;
  description: string | null;
  center_lat: number | null;
  center_lng: number | null;
}

interface DbVote {
  id: string;
  user_id: string;
  pin_id: string;
  vote: 'highly_interested' | 'would_do_with_group' | 'want_more_info' | 'not_interested';
  created_at: string;
  updated_at: string;
}

// Vote tier configuration
const VOTE_TIERS = {
  highly_interested: { label: 'Must do!', emoji: '🔥', countsAsYes: true },
  would_do_with_group: { label: 'I\'d join', emoji: '👍', countsAsYes: true },
  want_more_info: { label: 'Tell me more', emoji: '🤔', countsAsYes: false },
  not_interested: { label: 'Not for me', emoji: '👎', countsAsYes: false },
} as const;

type VoteTier = keyof typeof VOTE_TIERS;

// Categories that support voting by default
const VOTABLE_CATEGORIES = ['Tourist Activity'];

// Helper to check if a pin is votable
function isPinVotable(pin: Pin): boolean {
  // Check override first, then category
  if (pin.votable === true) return true;
  if (pin.votable === false) return false;
  return VOTABLE_CATEGORIES.includes(pin.category);
}

// Poll interfaces
interface DbPoll {
  id: string;
  question: string;
  description: string | null;
  sort_order: number;
  created_by: string | null;
  created_at: string;
}

interface DbPollVote {
  id: string;
  user_id: string;
  poll_id: string;
  vote: VoteTier;
  created_at: string;
  updated_at: string;
}

// Profile interface
interface DbProfile {
  id: string;
  email: string | null;
  display_name: string | null;
  is_site_admin: boolean;
  created_at: string;
  updated_at: string;
}

// Group interfaces
interface DbGroup {
  id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
}

interface DbGroupMember {
  id: string;
  group_id: string;
  user_id: string;
  role: 'admin' | 'member';
  status: 'pending' | 'approved' | 'denied';
  requested_at: string;
  approved_at: string | null;
  approved_by: string | null;
}

// Profile state
let currentProfile: DbProfile | null = null;
let profilesCache: Map<string, DbProfile> = new Map(); // userId -> profile

// Group state
let currentGroup: DbGroup | null = null;
let userGroups: DbGroup[] = []; // Groups the user is an approved member of
let userGroupMemberships: Map<string, DbGroupMember> = new Map(); // groupId -> membership
let pendingRequests: DbGroupMember[] = []; // User's pending join requests
let allGroups: DbGroup[] = []; // All groups (for browsing)

// Helper to check if user is admin of current group
// Site admins (is_site_admin in profile) are always considered group admins
function isGroupAdmin(): boolean {
  if (isAdmin) return true; // Site admin = always group admin
  if (!currentGroup) return false;
  const membership = userGroupMemberships.get(currentGroup.id);
  return membership?.role === 'admin' && membership?.status === 'approved';
}

// Helper to check if user can vote (is approved member of current group)
// Site admins can vote in any group they have a membership in (even if pending)
function canVote(): boolean {
  if (!currentGroup) return false;
  const membership = userGroupMemberships.get(currentGroup.id);
  if (!membership) return false;
  if (isAdmin) return true; // Site admin = always can vote
  return membership?.status === 'approved';
}

// Poll state
let polls: DbPoll[] = [];
let userPollVotes: Map<string, VoteTier> = new Map(); // pollId -> vote
let allPollVotes: Map<string, DbPollVote[]> = new Map(); // pollId -> all votes

// Site admin status (loaded from profile)
let isAdmin = false;

async function loadConfig(): Promise<MapConfig> {
  // If Supabase is configured, load from database
  if (supabase) {
    const [categoriesRes, pinsRes, configRes, regionsRes] = await Promise.all([
      supabase.from('categories').select('*'),
      supabase.from('pins').select('*'),
      supabase.from('map_config').select('*').limit(1).single(),
      supabase.from('regions').select('*')
    ]);

    if (categoriesRes.error) throw new Error(`Failed to load categories: ${categoriesRes.error.message}`);
    if (pinsRes.error) throw new Error(`Failed to load pins: ${pinsRes.error.message}`);
    if (configRes.error) throw new Error(`Failed to load map config: ${configRes.error.message}`);
    // Regions are optional - don't fail if they don't exist yet
    const dbRegions = (regionsRes.data || []) as DbRegion[];

    const dbCategories = categoriesRes.data as DbCategory[];
    const dbPins = pinsRes.data as DbPin[];
    const dbConfig = configRes.data as DbMapConfig;

    // Build category lookup
    const categoryMap = new Map<string, string>();
    dbCategories.forEach(c => categoryMap.set(c.id, c.name));

    // Build region lookup
    const regionMap = new Map<string, string>();
    dbRegions.forEach(r => regionMap.set(r.id, r.name));

    // Transform to app format
    const categories: Category[] = dbCategories.map(c => ({
      id: c.id,
      name: c.name,
      color: c.color
    }));

    const pins: Pin[] = dbPins.map(p => ({
      id: p.id,
      name: p.name,
      coordinates: [p.lat, p.lng] as [number, number],
      description: p.description,
      category: categoryMap.get(p.category_id) || 'Unknown',
      region: (p as any).region_id ? regionMap.get((p as any).region_id) : undefined,
      votable: (p as any).votable ?? undefined,
      link: p.link || undefined,
      maps_link: p.maps_link || undefined,
      extended_description: p.extended_description || undefined,
      cost: p.cost || undefined,
      tips: p.tips || undefined,
      photos: p.photos || undefined,
      distance: p.distance || undefined,
      elevation_gain: p.elevation_gain || undefined,
      gpx: p.gpx || undefined
    }));

    return {
      map: {
        center: [dbConfig.center_lat, dbConfig.center_lng],
        zoom: dbConfig.zoom
      },
      categories,
      pins
    };
  }

  // Fallback to YAML file (for local dev without Supabase)
  const response = await fetch('./pins.yaml');
  const text = await response.text();
  return yaml.load(text) as MapConfig;
}

// Vote management
let currentUserId: string | null = null;
let userVotes: Map<string, VoteTier> = new Map(); // pinId -> vote
let allVotes: Map<string, DbVote[]> = new Map(); // pinId -> all votes

// Load current user's profile
async function loadProfile(): Promise<void> {
  if (!supabase) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  currentUserId = user.id;

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (profile) {
    currentProfile = profile;
    profilesCache.set(user.id, profile);
    isAdmin = profile.is_site_admin;
  } else {
    // Profile doesn't exist yet (shouldn't happen with trigger, but fallback)
    isAdmin = false;
  }
}

// Load profiles for a list of user IDs (for display names)
async function loadProfilesForUsers(userIds: string[]): Promise<void> {
  if (!supabase || userIds.length === 0) return;

  // Filter out already cached profiles
  const uncachedIds = userIds.filter(id => !profilesCache.has(id));
  if (uncachedIds.length === 0) return;

  const { data: profiles } = await supabase
    .from('profiles')
    .select('*')
    .in('id', uncachedIds);

  for (const profile of (profiles || [])) {
    profilesCache.set(profile.id, profile);
  }
}

// Get display name for a user (from cache)
function getDisplayName(userId: string): string {
  const profile = profilesCache.get(userId);
  return profile?.display_name || profile?.email || userId.substring(0, 8) + '...';
}

// Update current user's display name
async function updateDisplayName(newName: string): Promise<boolean> {
  if (!supabase || !currentUserId) return false;

  const { error } = await supabase
    .from('profiles')
    .update({ display_name: newName, updated_at: new Date().toISOString() })
    .eq('id', currentUserId);

  if (error) {
    console.error('Failed to update display name:', error);
    return false;
  }

  // Update local state
  if (currentProfile) {
    currentProfile.display_name = newName;
    profilesCache.set(currentUserId, currentProfile);
  }

  return true;
}

// Load user's groups and set current group
async function loadGroups(): Promise<void> {
  if (!supabase) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  currentUserId = user.id;

  // Load all groups (for browsing)
  const { data: groupsData } = await supabase
    .from('groups')
    .select('*')
    .order('created_at', { ascending: false });

  allGroups = groupsData || [];

  // Load user's memberships
  const { data: membershipsData } = await supabase
    .from('group_members')
    .select('*')
    .eq('user_id', user.id);

  userGroupMemberships.clear();
  pendingRequests = [];
  userGroups = [];

  for (const membership of (membershipsData || [])) {
    userGroupMemberships.set(membership.group_id, membership);

    if (membership.status === 'pending') {
      pendingRequests.push(membership);
    } else if (membership.status === 'approved') {
      const group = allGroups.find(g => g.id === membership.group_id);
      if (group) userGroups.push(group);
    }
  }

  // Restore current group from localStorage or default to first group
  const savedGroupId = localStorage.getItem('currentGroupId');
  if (savedGroupId) {
    const savedGroup = userGroups.find(g => g.id === savedGroupId);
    if (savedGroup) {
      currentGroup = savedGroup;
    } else {
      currentGroup = userGroups[0] || null;
    }
  } else {
    currentGroup = userGroups[0] || null;
  }

  // Save current group to localStorage
  if (currentGroup) {
    localStorage.setItem('currentGroupId', currentGroup.id);
  } else {
    localStorage.removeItem('currentGroupId');
  }
}

// Switch to a different group
function switchGroup(groupId: string | null): void {
  if (groupId === null) {
    currentGroup = null;
    localStorage.removeItem('currentGroupId');
  } else {
    const group = userGroups.find(g => g.id === groupId);
    if (group) {
      currentGroup = group;
      localStorage.setItem('currentGroupId', groupId);
    }
  }
}

async function loadVotes(): Promise<void> {
  if (!supabase) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  currentUserId = user.id;

  // Only load votes if we have a current group
  if (!currentGroup) {
    allVotes.clear();
    userVotes.clear();
    return;
  }

  // Load votes for the current group only
  const { data: votes, error } = await supabase
    .from('user_votes')
    .select('*')
    .eq('group_id', currentGroup.id);

  if (error) {
    console.error('Failed to load votes:', error);
    return;
  }

  // Organize votes by pin
  allVotes.clear();
  userVotes.clear();

  for (const vote of (votes || [])) {
    const pinVotes = allVotes.get(vote.pin_id) || [];
    pinVotes.push(vote);
    allVotes.set(vote.pin_id, pinVotes);

    // Track current user's votes
    if (vote.user_id === currentUserId) {
      userVotes.set(vote.pin_id, vote.vote as VoteTier);
    }
  }
}

async function submitVote(pinId: string, vote: VoteTier): Promise<boolean> {
  if (!supabase || !currentUserId || !currentGroup) return false;

  // Upsert the vote (insert or update)
  const { error } = await supabase
    .from('user_votes')
    .upsert({
      user_id: currentUserId,
      pin_id: pinId,
      group_id: currentGroup.id,
      vote: vote,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id,pin_id,group_id'
    });

  if (error) {
    console.error('Failed to submit vote:', error);
    return false;
  }

  // Update local state
  userVotes.set(pinId, vote);

  // Update allVotes
  const pinVotes = allVotes.get(pinId) || [];
  const existingIdx = pinVotes.findIndex(v => v.user_id === currentUserId);
  if (existingIdx >= 0) {
    pinVotes[existingIdx].vote = vote;
  } else {
    pinVotes.push({
      id: '',
      user_id: currentUserId,
      pin_id: pinId,
      vote: vote,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }
  allVotes.set(pinId, pinVotes);

  return true;
}

async function removeVote(pinId: string): Promise<boolean> {
  if (!supabase || !currentUserId || !currentGroup) return false;

  const { error } = await supabase
    .from('user_votes')
    .delete()
    .eq('user_id', currentUserId)
    .eq('pin_id', pinId)
    .eq('group_id', currentGroup.id);

  if (error) {
    console.error('Failed to remove vote:', error);
    return false;
  }

  // Update local state
  userVotes.delete(pinId);

  // Update allVotes
  const pinVotes = allVotes.get(pinId) || [];
  const filteredVotes = pinVotes.filter(v => v.user_id !== currentUserId);
  allVotes.set(pinId, filteredVotes);

  return true;
}

// Poll functions
async function loadPolls(): Promise<void> {
  if (!supabase) return;

  // Only load polls if we have a current group
  if (!currentGroup) {
    polls = [];
    allPollVotes.clear();
    userPollVotes.clear();
    return;
  }

  // Load polls for the current group
  const { data: pollsData, error: pollsError } = await supabase
    .from('polls')
    .select('*')
    .eq('group_id', currentGroup.id)
    .order('sort_order', { ascending: true });

  if (pollsError) {
    console.error('Failed to load polls:', pollsError);
    return;
  }

  polls = pollsData || [];

  // Load poll votes for the current group
  const { data: votesData, error: votesError } = await supabase
    .from('poll_votes')
    .select('*')
    .eq('group_id', currentGroup.id);

  if (votesError) {
    console.error('Failed to load poll votes:', votesError);
    return;
  }

  // Organize votes by poll
  allPollVotes.clear();
  userPollVotes.clear();

  for (const vote of (votesData || [])) {
    const pollVotes = allPollVotes.get(vote.poll_id) || [];
    pollVotes.push(vote);
    allPollVotes.set(vote.poll_id, pollVotes);

    if (vote.user_id === currentUserId) {
      userPollVotes.set(vote.poll_id, vote.vote as VoteTier);
    }
  }
}

async function submitPollVote(pollId: string, vote: VoteTier): Promise<boolean> {
  if (!supabase || !currentUserId || !currentGroup) return false;

  const { error } = await supabase
    .from('poll_votes')
    .upsert({
      user_id: currentUserId,
      poll_id: pollId,
      group_id: currentGroup.id,
      vote: vote,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id,poll_id,group_id'
    });

  if (error) {
    console.error('Failed to submit poll vote:', error);
    return false;
  }

  // Update local state
  userPollVotes.set(pollId, vote);

  const pollVotes = allPollVotes.get(pollId) || [];
  const existingIdx = pollVotes.findIndex(v => v.user_id === currentUserId);
  if (existingIdx >= 0) {
    pollVotes[existingIdx].vote = vote;
  } else {
    pollVotes.push({
      id: '',
      user_id: currentUserId,
      poll_id: pollId,
      vote: vote,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }
  allPollVotes.set(pollId, pollVotes);

  return true;
}

async function removePollVote(pollId: string): Promise<boolean> {
  if (!supabase || !currentUserId || !currentGroup) return false;

  const { error } = await supabase
    .from('poll_votes')
    .delete()
    .eq('user_id', currentUserId)
    .eq('poll_id', pollId)
    .eq('group_id', currentGroup.id);

  if (error) {
    console.error('Failed to remove poll vote:', error);
    return false;
  }

  userPollVotes.delete(pollId);

  const pollVotes = allPollVotes.get(pollId) || [];
  const filteredVotes = pollVotes.filter(v => v.user_id !== currentUserId);
  allPollVotes.set(pollId, filteredVotes);

  return true;
}

async function createPoll(question: string, description?: string): Promise<boolean> {
  if (!supabase || !currentUserId || !currentGroup) return false;

  const { error } = await supabase
    .from('polls')
    .insert({
      question,
      description: description || null,
      group_id: currentGroup.id,
      created_by: currentUserId,
      sort_order: polls.length + 10
    });

  if (error) {
    console.error('Failed to create poll:', error);
    return false;
  }

  // Reload polls
  await loadPolls();
  return true;
}

async function deletePoll(pollId: string): Promise<boolean> {
  // Allow deletion if user is global admin or group admin
  if (!supabase || (!isAdmin && !isGroupAdmin())) return false;

  const { error } = await supabase
    .from('polls')
    .delete()
    .eq('id', pollId);

  if (error) {
    console.error('Failed to delete poll:', error);
    return false;
  }

  // Reload polls
  await loadPolls();
  return true;
}

function getPollVoteSummary(pollId: string): { positive: number; total: number; breakdown: Record<VoteTier, number> } {
  const votes = allPollVotes.get(pollId) || [];
  const breakdown: Record<VoteTier, number> = {
    highly_interested: 0,
    would_do_with_group: 0,
    want_more_info: 0,
    not_interested: 0
  };

  for (const vote of votes) {
    breakdown[vote.vote as VoteTier]++;
  }

  const positive = breakdown.highly_interested + breakdown.would_do_with_group;
  return { positive, total: votes.length, breakdown };
}

function getVoteSummary(pinId: string): { positive: number; total: number; breakdown: Record<VoteTier, number> } {
  const votes = allVotes.get(pinId) || [];
  const breakdown: Record<VoteTier, number> = {
    highly_interested: 0,
    would_do_with_group: 0,
    want_more_info: 0,
    not_interested: 0
  };

  for (const vote of votes) {
    breakdown[vote.vote as VoteTier]++;
  }

  const positive = breakdown.highly_interested + breakdown.would_do_with_group;
  return { positive, total: votes.length, breakdown };
}

// ========== GROUP MANAGEMENT FUNCTIONS ==========

async function createGroup(name: string, description?: string): Promise<DbGroup | null> {
  if (!supabase || !currentUserId) return null;

  // Create the group
  const { data: group, error: groupError } = await supabase
    .from('groups')
    .insert({
      name,
      description: description || null,
      created_by: currentUserId
    })
    .select()
    .single();

  if (groupError || !group) {
    console.error('Failed to create group:', groupError);
    return null;
  }

  // Add creator as admin member
  const { error: memberError } = await supabase
    .from('group_members')
    .insert({
      group_id: group.id,
      user_id: currentUserId,
      role: 'admin',
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: currentUserId
    });

  if (memberError) {
    console.error('Failed to add creator as admin:', memberError);
    // Clean up the group if member creation failed
    await supabase.from('groups').delete().eq('id', group.id);
    return null;
  }

  // Reload groups
  await loadGroups();
  return group;
}

async function requestJoinGroup(groupId: string): Promise<boolean> {
  if (!supabase || !currentUserId) return false;

  // Check if user already has a membership (pending, approved, or denied)
  const { data: existing } = await supabase
    .from('group_members')
    .select('id, status')
    .eq('group_id', groupId)
    .eq('user_id', currentUserId)
    .single();

  if (existing) {
    if (existing.status === 'pending') {
      alert('You already have a pending request for this group.');
      return false;
    } else if (existing.status === 'denied') {
      // Allow re-requesting - update the existing record back to pending
      const { error } = await supabase
        .from('group_members')
        .update({
          status: 'pending',
          requested_at: new Date().toISOString(),
          approved_at: null,
          approved_by: null
        })
        .eq('id', existing.id);

      if (error) {
        console.error('Failed to re-request join:', error);
        return false;
      }

      await loadGroups();
      return true;
    } else {
      alert('You are already a member of this group.');
      return false;
    }
  }

  const { error } = await supabase
    .from('group_members')
    .insert({
      group_id: groupId,
      user_id: currentUserId,
      role: 'member',
      status: 'pending'
    });

  if (error) {
    console.error('Failed to request join:', error);
    if (error.code === '23505') {
      alert('You already have a request for this group.');
    }
    return false;
  }

  await loadGroups();
  return true;
}

async function leaveGroup(groupId: string): Promise<boolean> {
  if (!supabase || !currentUserId) return false;

  const { error } = await supabase
    .from('group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('user_id', currentUserId);

  if (error) {
    console.error('Failed to leave group:', error);
    return false;
  }

  // If leaving current group, switch to another or null
  if (currentGroup?.id === groupId) {
    await loadGroups();
    // loadGroups will set currentGroup to the first available group or null
  } else {
    await loadGroups();
  }

  return true;
}

async function approveJoinRequest(membershipId: string): Promise<boolean> {
  if (!supabase || !currentUserId) return false;

  const { error } = await supabase
    .from('group_members')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: currentUserId
    })
    .eq('id', membershipId);

  if (error) {
    console.error('Failed to approve request:', error);
    return false;
  }

  return true;
}

async function denyJoinRequest(membershipId: string): Promise<boolean> {
  if (!supabase || !currentUserId) return false;

  const { error } = await supabase
    .from('group_members')
    .update({
      status: 'denied'
    })
    .eq('id', membershipId);

  if (error) {
    console.error('Failed to deny request:', error);
    return false;
  }

  return true;
}

async function removeMember(membershipId: string): Promise<boolean> {
  if (!supabase) return false;

  const { error } = await supabase
    .from('group_members')
    .delete()
    .eq('id', membershipId);

  if (error) {
    console.error('Failed to remove member:', error);
    return false;
  }

  return true;
}

async function deleteGroup(groupId: string): Promise<boolean> {
  if (!supabase) return false;

  const { error } = await supabase
    .from('groups')
    .delete()
    .eq('id', groupId);

  if (error) {
    console.error('Failed to delete group:', error);
    return false;
  }

  // Reload groups
  await loadGroups();
  return true;
}

async function loadGroupMembers(groupId: string): Promise<DbGroupMember[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('group_members')
    .select('*')
    .eq('group_id', groupId)
    .order('status', { ascending: true })
    .order('requested_at', { ascending: true });

  if (error) {
    console.error('Failed to load group members:', error);
    return [];
  }

  return data || [];
}

function createCustomIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div class="marker-pin" style="--marker-color: ${color}">
      <div class="marker-dot"></div>
      <div class="marker-pulse"></div>
    </div>`,
    iconSize: [30, 42],
    iconAnchor: [15, 30],
    popupAnchor: [0, -30],
  });
}

function renderLegend(
  categories: Category[],
  activeCategoriesSet: Set<string>,
  onToggleCategory: (categoryName: string) => void
): void {
  const legendEl = document.getElementById('legend')!;

  // Create legend header with hide button
  const header = document.createElement('div');
  header.className = 'legend-header';

  const title = document.createElement('h3');
  title.textContent = 'Legend';

  const hideBtn = document.createElement('button');
  hideBtn.className = 'legend-hide-btn';
  hideBtn.innerHTML = '&times;';
  hideBtn.id = 'legend-hide-btn';

  header.appendChild(title);
  header.appendChild(hideBtn);
  legendEl.appendChild(header);

  categories.forEach(category => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.dataset.category = category.name;

    const itemContent = document.createElement('div');
    itemContent.className = 'legend-item-content';

    // Add checkbox indicator (shows category color when active)
    const checkbox = document.createElement('div');
    checkbox.className = 'legend-checkbox';
    checkbox.style.backgroundColor = category.color;
    checkbox.style.borderColor = category.color;

    const label = document.createElement('span');
    label.textContent = category.name;

    itemContent.appendChild(checkbox);
    itemContent.appendChild(label);
    item.appendChild(itemContent);

    // Add hike mode button for Hike category
    if (category.name === 'Hike') {
      const hikeModeBtn = document.createElement('button');
      hikeModeBtn.className = 'hike-mode-btn';
      hikeModeBtn.textContent = 'Filter';
      hikeModeBtn.id = 'hike-mode-btn';
      item.appendChild(hikeModeBtn);
    }

    // Set initial state
    if (!activeCategoriesSet.has(category.name)) {
      item.classList.add('inactive');
    }

    // Add click handler (only for the content, not the hike mode button)
    itemContent.addEventListener('click', () => {
      onToggleCategory(category.name);

      // Toggle visual state
      if (activeCategoriesSet.has(category.name)) {
        item.classList.remove('inactive');
      } else {
        item.classList.add('inactive');
      }
    });

    legendEl.appendChild(item);
  });
}

// Set up real-time subscriptions for vote updates
function setupRealtimeSubscriptions(
  onVotesChange: () => void,
  onPollVotesChange: () => void
): void {
  if (!supabase) return;

  // Subscribe to user_votes changes
  supabase
    .channel('user_votes_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'user_votes' },
      async () => {
        await loadVotes();
        onVotesChange();
      }
    )
    .subscribe();

  // Subscribe to poll_votes changes
  supabase
    .channel('poll_votes_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'poll_votes' },
      async () => {
        await loadPolls();
        onPollVotesChange();
      }
    )
    .subscribe();

  // Subscribe to polls changes (new questions added/deleted)
  supabase
    .channel('polls_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'polls' },
      async () => {
        await loadPolls();
        onPollVotesChange();
      }
    )
    .subscribe();
}

async function initMap(): Promise<void> {
  try {
    const config = await loadConfig();

    // Load profile first (sets isAdmin), then groups, votes, and polls
    await loadProfile();
    await loadGroups();
    await loadVotes();
    await loadPolls();

    // Initialize map with double-tap zoom enabled for mobile
    const map = L.map('map', {
      doubleClickZoom: true,
      tapTolerance: 15
    }).setView(config.map.center, config.map.zoom);

    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    // Create category color map
    const categoryColors = new Map<string, string>();
    config.categories.forEach(cat => {
      categoryColors.set(cat.name, cat.color);
    });

    // Track active categories (all active by default except "Mountain Peak")
    const activeCategories = new Set<string>(
      config.categories
        .filter(c => c.name !== 'Mountain Peak')
        .map(c => c.name)
    );

    // Parse URL query parameters to override initial category selection
    const urlParams = new URLSearchParams(window.location.search);
    const categoriesParam = urlParams.get('categories');

    if (categoriesParam) {
      // Clear default selection
      activeCategories.clear();

      // Parse comma-separated category names (URLSearchParams automatically decodes + as space)
      const requestedCategories = categoriesParam.split(',').map(c => c.trim());

      // Only add categories that actually exist in the config (case-insensitive matching)
      requestedCategories.forEach(catName => {
        const matchedCategory = config.categories.find(c => c.name.toLowerCase() === catName.toLowerCase());
        if (matchedCategory) {
          activeCategories.add(matchedCategory.name); // Use the correctly-cased name from config
        } else {
          console.warn(`Category "${catName}" from URL not found in config`);
        }
      });
    }

    // Store all markers by category
    const markersByCategory = new Map<string, { cluster: L.Marker; normal: L.Marker }[]>();
    config.categories.forEach(cat => {
      markersByCategory.set(cat.name, []);
    });

    // Store markers by pin ID for popup updates
    const markersByPinId = new Map<string, { cluster: L.Marker; normal: L.Marker; pin: Pin }>();

    // Create both clustered and non-clustered groups
    const clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
    });

    const normalGroup = L.layerGroup();

    // Hike mode state (declare early before updateVisibleMarkers is called)
    let hikeModeActive = false;
    let currentMinDistance = 0;
    let currentMaxDistance = 100;
    let currentMinElevation = 0;
    let currentMaxElevation = 10000;
    let preHikeModeCategories: Set<string> | null = null;

    // Routing state
    let routingControl: L.Routing.Control | null = null;

    // Hike GPX routes - displayed when hike category is visible
    const hikeRoutesLayer = L.layerGroup().addTo(map);

    // Load all hike GPX routes (permanently shown when Hike category is visible)
    async function updateHikeRoutes() {
      hikeRoutesLayer.clearLayers();

      // Only show routes when Hike category is active
      if (!activeCategories.has('Hike')) return;

      // Load all GPX routes for hikes that have them
      const hikePins = config.pins.filter(pin => pin.category === 'Hike' && pin.gpx);

      for (const pin of hikePins) {
        const coordinates = await fetchAndParseGPX(`./gpx/${pin.gpx}`);
        if (coordinates.length > 0) {
          L.polyline(coordinates, {
            color: '#ff3333',
            weight: 3,
            opacity: 0.7,
            lineCap: 'round',
            lineJoin: 'round'
          }).addTo(hikeRoutesLayer);
        }
      }
    }

    // Store markers with their data for later reference
    const markerDataMap = new Map<L.Marker, Pin>();
    // Store markers by pin name for search functionality
    const pinMarkers = new Map<string, L.Marker>();

    // Helper to create popup content with voting
    function createPopupContent(pin: Pin): string {
      const userVote = userVotes.get(pin.id);
      const summary = getVoteSummary(pin.id);

      let popupContent = `<strong>${pin.name}</strong><br>${pin.description}`;

      // Add cost for Tourist Activity pins
      if (pin.cost) {
        popupContent += `<br><strong>Cost:</strong> ${pin.cost}`;
      }

      // Add tips if available
      if (pin.tips) {
        popupContent += `<br><strong>Time:</strong> ${pin.tips}`;
      }

      const links: string[] = [];
      if (pin.link) {
        links.push(`<a href="${pin.link}" target="_blank">Learn more</a>`);
      }
      if (pin.maps_link) {
        links.push(`<a href="${pin.maps_link}" target="_blank">View on map</a>`);
      }

      if (links.length > 0) {
        popupContent += `<br>${links.join(' • ')}`;
      }

      // Only show voting for votable pins AND if user can vote (is in a group)
      if (isPinVotable(pin) && canVote()) {
        // Add vote summary if there are votes
        if (summary.total > 0) {
          popupContent += `<div class="popup-vote-summary">${summary.positive}/${summary.total} interested</div>`;
        }

        // Add voting buttons
        popupContent += `<div class="popup-vote-buttons" data-pin-id="${pin.id}">`;
        for (const [tier, config] of Object.entries(VOTE_TIERS)) {
          const isActive = userVote === tier;
          popupContent += `<button class="popup-vote-btn${isActive ? ' active' : ''}" data-vote="${tier}" title="${config.label}">${config.emoji}</button>`;
        }
        popupContent += '</div>';
      }

      return popupContent;
    }

    // Create all markers and organize by category
    config.pins.forEach(pin => {
      const color = categoryColors.get(pin.category) || '#gray';
      const icon = createCustomIcon(color);

      // Create popup content
      const popupContent = createPopupContent(pin);

      // Popup options - only constrain on mobile via CSS
      const isMobile = window.innerWidth <= 768;
      const popupOptions: L.PopupOptions = {
        autoPan: true,
        autoPanPadding: isMobile ? L.point(50, 50) : L.point(20, 20),
        keepInView: isMobile
      };

      // Create markers for both groups
      const clusterMarker = L.marker(pin.coordinates, { icon });
      clusterMarker.bindPopup(popupContent, popupOptions);

      const normalMarker = L.marker(pin.coordinates, { icon });
      normalMarker.bindPopup(popupContent, popupOptions);

      // Store markers by category
      const categoryMarkers = markersByCategory.get(pin.category) || [];
      categoryMarkers.push({ cluster: clusterMarker, normal: normalMarker });
      markersByCategory.set(pin.category, categoryMarkers);

      // Store markers by pin ID for popup updates
      markersByPinId.set(pin.id, { cluster: clusterMarker, normal: normalMarker, pin });

      // Map markers to pin data (do this immediately when creating markers)
      markerDataMap.set(clusterMarker, pin);
      markerDataMap.set(normalMarker, pin);

      // Store marker reference by pin name for search
      pinMarkers.set(pin.name, clusterMarker);
    });

    // Function to update visible markers based on active categories
    function updateVisibleMarkers() {
      // Clear both groups
      clusterGroup.clearLayers();
      normalGroup.clearLayers();

      // Add markers from active categories
      activeCategories.forEach(category => {
        const markers = markersByCategory.get(category) || [];

        markers.forEach(({ cluster, normal }) => {
          let shouldAddMarker = true;

          // If in hike mode and this is a hike, apply filters
          if (hikeModeActive && category === 'Hike') {
            const pin = markerDataMap.get(cluster);

            if (pin && pin.distance && pin.elevation_gain) {
              const passesDistanceFilter = pin.distance >= currentMinDistance && pin.distance <= currentMaxDistance;
              const passesElevationFilter = pin.elevation_gain >= currentMinElevation && pin.elevation_gain <= currentMaxElevation;

              if (!passesDistanceFilter || !passesElevationFilter) {
                shouldAddMarker = false;
              }
            }
          }

          if (shouldAddMarker) {
            clusterGroup.addLayer(cluster);
            normalGroup.addLayer(normal);
          }
        });
      });
    }

    // Initialize with all markers visible
    updateVisibleMarkers();

    // Load hike GPX routes
    updateHikeRoutes();

    // Start with clustering off (based on user's preference)
    let clusteringEnabled = false;
    map.addLayer(normalGroup);

    // Toggle functionality
    const toggleButton = document.getElementById('cluster-toggle')!;
    const toggleSwitch = document.getElementById('toggle-switch')!;

    toggleButton.addEventListener('click', () => {
      clusteringEnabled = !clusteringEnabled;

      if (clusteringEnabled) {
        map.removeLayer(normalGroup);
        map.addLayer(clusterGroup);
        toggleSwitch.classList.add('active');
      } else {
        map.removeLayer(clusterGroup);
        map.addLayer(normalGroup);
        toggleSwitch.classList.remove('active');
      }
    });

    // Side panel functionality
    const sidePanel = document.getElementById('side-panel')!;
    const panelContent = document.getElementById('panel-content')!;
    const panelToggle = document.getElementById('panel-toggle')!;
    const panelClose = document.getElementById('panel-close')!;
    const mapElement = document.getElementById('map')!;

    // Populate side panel with location cards
    function renderSidePanel() {
      panelContent.innerHTML = '';

      config.pins.forEach((pin) => {
        // Skip if category is not active
        if (!activeCategories.has(pin.category)) return;

        // If in hike mode, apply distance/elevation filters
        if (hikeModeActive && pin.category === 'Hike') {
          if (pin.distance && pin.elevation_gain) {
            const passesDistanceFilter = pin.distance >= currentMinDistance && pin.distance <= currentMaxDistance;
            const passesElevationFilter = pin.elevation_gain >= currentMinElevation && pin.elevation_gain <= currentMaxElevation;
            if (!passesDistanceFilter || !passesElevationFilter) {
              return;
            }
          }
        }

        const card = document.createElement('div');
        card.className = 'location-card';
        card.dataset.pinName = pin.name;

        const color = categoryColors.get(pin.category) || '#gray';

        let cardHTML = `
          <div class="card-header">
            <div class="card-category-dot" style="background-color: ${color}"></div>
            <div class="card-title">
              <h3>${pin.name}</h3>
              <div class="card-category-name">${pin.category}</div>
            </div>
          </div>
          <div class="card-description">${pin.description}</div>
        `;

        if (pin.extended_description) {
          cardHTML += `<div class="card-extended">${pin.extended_description}</div>`;
        }

        if (pin.cost || pin.tips) {
          cardHTML += '<div class="card-meta">';
          if (pin.cost) {
            cardHTML += `<div class="card-meta-item"><span class="card-meta-label">Cost:</span> ${pin.cost}</div>`;
          }
          if (pin.tips) {
            cardHTML += `<div class="card-meta-item"><span class="card-meta-label">Tips:</span> ${pin.tips}</div>`;
          }
          cardHTML += '</div>';
        }

        // Add voting section for votable pins (only if user can vote)
        if (isPinVotable(pin) && canVote()) {
          const summary = getVoteSummary(pin.id);
          const userVote = userVotes.get(pin.id);

          cardHTML += '<div class="card-voting">';
          if (summary.total > 0) {
            cardHTML += `<div class="card-vote-summary">${summary.positive}/${summary.total} interested</div>`;
          }
          cardHTML += `<div class="card-vote-buttons" data-pin-id="${pin.id}">`;
          for (const [tier, config] of Object.entries(VOTE_TIERS)) {
            const isActive = userVote === tier;
            cardHTML += `<button class="card-vote-btn${isActive ? ' active' : ''}" data-vote="${tier}" title="${config.label}">${config.emoji}</button>`;
          }
          cardHTML += '</div></div>';
        }

        cardHTML += '<div class="card-actions">';
        cardHTML += '<button class="card-button card-button-primary view-on-map-btn">View on Map</button>';
        if (pin.link) {
          cardHTML += `<a href="${pin.link}" target="_blank" class="card-button card-button-secondary">Learn More</a>`;
        }
        if (pin.maps_link) {
          cardHTML += `<a href="${pin.maps_link}" target="_blank" class="card-button card-button-secondary">Directions</a>`;
        }
        cardHTML += '</div>';

        card.innerHTML = cardHTML;

        // Click handler for "View on Map" button
        const viewOnMapBtn = card.querySelector('.view-on-map-btn') as HTMLButtonElement;
        viewOnMapBtn.addEventListener('click', (e) => {
          e.stopPropagation();

          // Find the marker for this pin by matching coordinates
          const markers = markersByCategory.get(pin.category) || [];
          const markerPair = markers.find(m => {
            const markerLatLng = m.normal.getLatLng();
            return markerLatLng.lat === pin.coordinates[0] && markerLatLng.lng === pin.coordinates[1];
          });

          if (markerPair) {
            const marker = clusteringEnabled ? markerPair.cluster : markerPair.normal;

            // Zoom to marker location with smooth animation
            map.flyTo(pin.coordinates, 12, {
              duration: 1.2,
              easeLinearity: 0.25
            });

            // Open popup after animation starts
            setTimeout(() => {
              marker.openPopup();
            }, 600);

            // Highlight card
            document.querySelectorAll('.location-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
          } else {
            console.error('Could not find marker for pin:', pin.name);
          }
        });

        // Click handler for entire card
        card.addEventListener('click', () => {
          const viewEvent = new MouseEvent('click', { bubbles: true });
          viewOnMapBtn.dispatchEvent(viewEvent);
        });

        panelContent.appendChild(card);
      });
    }

    // Initial render
    renderSidePanel();

    // Outcomes tab elements
    const outcomesContent = document.getElementById('outcomes-content')!;
    const panelTabs = document.querySelectorAll('.panel-tab');

    // Render outcomes tab
    function renderOutcomesTab() {
      // If user is not in a group, show a message
      if (!canVote()) {
        outcomesContent.innerHTML = `
          <div class="outcomes-empty">
            <div class="outcomes-empty-icon">👥</div>
            <p>Join a group to vote!</p>
            <p style="font-size: 13px;">You need to be part of a trip group to see and participate in voting.</p>
            <button class="add-poll-btn" id="open-groups-btn" style="margin-top: 16px;">Manage Groups</button>
          </div>
        `;
        // Add click handler for groups button
        const groupsBtn = outcomesContent.querySelector('#open-groups-btn');
        if (groupsBtn) {
          groupsBtn.addEventListener('click', () => {
            showGroupsModal();
          });
        }
        return;
      }

      let html = '';

      // Show current group name
      if (currentGroup) {
        html += `<div class="outcomes-group-header">
          <span class="outcomes-group-name">${currentGroup.name}</span>
          <button class="outcomes-group-change" id="change-group-btn">Change</button>
        </div>`;
      }

      // ========== POLLS SECTION ==========
      if (polls.length > 0) {
        html += `<div class="outcomes-region polls-section">`;
        html += `<div class="outcomes-region-header">Group Preferences</div>`;

        for (const poll of polls) {
          const summary = getPollVoteSummary(poll.id);
          const userVote = userPollVotes.get(poll.id);

          html += `
            <div class="poll-item" data-poll-id="${poll.id}">
              <div class="poll-info">
                <div class="poll-question">${poll.question}</div>
                ${poll.description ? `<div class="poll-description">${poll.description}</div>` : ''}
                <div class="poll-breakdown">
                  <span>🔥 ${summary.breakdown.highly_interested}</span>
                  <span>👍 ${summary.breakdown.would_do_with_group}</span>
                  <span>🤔 ${summary.breakdown.want_more_info}</span>
                  <span>👎 ${summary.breakdown.not_interested}</span>
                </div>
              </div>
              <div class="poll-vote-buttons" data-poll-id="${poll.id}">
                ${Object.entries(VOTE_TIERS).map(([tier, config]) => `
                  <button class="poll-vote-btn${userVote === tier ? ' active' : ''}" data-vote="${tier}" title="${config.label}">${config.emoji}</button>
                `).join('')}
              </div>
              ${(isAdmin || isGroupAdmin()) ? `<button class="poll-delete-btn" data-poll-id="${poll.id}" title="Delete question">&times;</button>` : ''}
            </div>
          `;
        }

        // Add new poll button
        html += `
          <button class="add-poll-btn" id="add-poll-btn">+ Add a question</button>
        `;

        html += `</div>`;
      } else {
        // No polls yet, show add button
        html += `
          <div class="outcomes-region polls-section">
            <div class="outcomes-region-header">Group Preferences</div>
            <p style="color: #888; margin-bottom: 12px;">No questions yet.</p>
            <button class="add-poll-btn" id="add-poll-btn">+ Add a question</button>
          </div>
        `;
      }

      // ========== LOCATIONS SECTION ==========
      // Group pins by region (only votable categories)
      const regionGroups = new Map<string, Pin[]>();
      const noRegion: Pin[] = [];

      config.pins
        .filter(pin => isPinVotable(pin))
        .forEach(pin => {
          if (pin.region) {
            const group = regionGroups.get(pin.region) || [];
            group.push(pin);
            regionGroups.set(pin.region, group);
          } else {
            noRegion.push(pin);
          }
        });

      // Check if there's anything to show
      const hasVotablePins = regionGroups.size > 0 || noRegion.length > 0;

      if (!hasVotablePins && polls.length === 0) {
        outcomesContent.innerHTML = `
          <div class="outcomes-empty">
            <div class="outcomes-empty-icon">🗳️</div>
            <p>No votable items yet!</p>
            <p style="font-size: 13px;">Add Tourist Activities or mark pins as votable to start collecting preferences.</p>
          </div>
        `;
        return;
      }

      // Render each region
      const regionOrder = ['Anchorage Area', 'Seward Area', 'North of Anchorage', 'Kenai Peninsula'];

      for (const regionName of regionOrder) {
        const pins = regionGroups.get(regionName);
        if (!pins || pins.length === 0) continue;

        html += `<div class="outcomes-region">`;
        html += `<div class="outcomes-region-header">${regionName}</div>`;

        for (const pin of pins) {
          const summary = getVoteSummary(pin.id);
          const userVote = userVotes.get(pin.id);

          html += `
            <div class="outcome-item" data-pin-name="${pin.name}" data-lat="${pin.coordinates[0]}" data-lng="${pin.coordinates[1]}" data-pin-id="${pin.id}">
              <div class="outcome-score">
                <span class="outcome-score-num">${summary.positive}</span>
                <span class="outcome-score-divider">/</span>
                <span class="outcome-score-total">${summary.total}</span>
              </div>
              <div class="outcome-content">
                <div class="outcome-name">${pin.name}</div>
                <div class="outcome-vote-buttons" data-pin-id="${pin.id}">
                  <div class="outcome-vote-option">
                    <button class="outcome-vote-btn${userVote === 'highly_interested' ? ' active' : ''}" data-vote="highly_interested" title="Must do!">🔥</button>
                    <span class="outcome-vote-count">${summary.breakdown.highly_interested}</span>
                  </div>
                  <div class="outcome-vote-option">
                    <button class="outcome-vote-btn${userVote === 'would_do_with_group' ? ' active' : ''}" data-vote="would_do_with_group" title="I'd join">👍</button>
                    <span class="outcome-vote-count">${summary.breakdown.would_do_with_group}</span>
                  </div>
                  <div class="outcome-vote-option">
                    <button class="outcome-vote-btn${userVote === 'want_more_info' ? ' active' : ''}" data-vote="want_more_info" title="Tell me more">🤔</button>
                    <span class="outcome-vote-count">${summary.breakdown.want_more_info}</span>
                  </div>
                  <div class="outcome-vote-option">
                    <button class="outcome-vote-btn${userVote === 'not_interested' ? ' active' : ''}" data-vote="not_interested" title="Not for me">👎</button>
                    <span class="outcome-vote-count">${summary.breakdown.not_interested}</span>
                  </div>
                </div>
              </div>
            </div>
          `;
        }

        html += `</div>`;
      }

      // Render pins without a region
      if (noRegion.length > 0) {
        html += `<div class="outcomes-region">`;
        html += `<div class="outcomes-region-header">Other Locations</div>`;

        for (const pin of noRegion) {
          const summary = getVoteSummary(pin.id);
          const userVote = userVotes.get(pin.id);

          html += `
            <div class="outcome-item" data-pin-name="${pin.name}" data-lat="${pin.coordinates[0]}" data-lng="${pin.coordinates[1]}" data-pin-id="${pin.id}">
              <div class="outcome-score">
                <span class="outcome-score-num">${summary.positive}</span>
                <span class="outcome-score-divider">/</span>
                <span class="outcome-score-total">${summary.total}</span>
              </div>
              <div class="outcome-content">
                <div class="outcome-name">${pin.name}</div>
                <div class="outcome-vote-buttons" data-pin-id="${pin.id}">
                  <div class="outcome-vote-option">
                    <button class="outcome-vote-btn${userVote === 'highly_interested' ? ' active' : ''}" data-vote="highly_interested" title="Must do!">🔥</button>
                    <span class="outcome-vote-count">${summary.breakdown.highly_interested}</span>
                  </div>
                  <div class="outcome-vote-option">
                    <button class="outcome-vote-btn${userVote === 'would_do_with_group' ? ' active' : ''}" data-vote="would_do_with_group" title="I'd join">👍</button>
                    <span class="outcome-vote-count">${summary.breakdown.would_do_with_group}</span>
                  </div>
                  <div class="outcome-vote-option">
                    <button class="outcome-vote-btn${userVote === 'want_more_info' ? ' active' : ''}" data-vote="want_more_info" title="Tell me more">🤔</button>
                    <span class="outcome-vote-count">${summary.breakdown.want_more_info}</span>
                  </div>
                  <div class="outcome-vote-option">
                    <button class="outcome-vote-btn${userVote === 'not_interested' ? ' active' : ''}" data-vote="not_interested" title="Not for me">👎</button>
                    <span class="outcome-vote-count">${summary.breakdown.not_interested}</span>
                  </div>
                </div>
              </div>
            </div>
          `;
        }

        html += `</div>`;
      }

      outcomesContent.innerHTML = html;

      // Add click handlers to outcome items (for panning to pin)
      outcomesContent.querySelectorAll('.outcome-item').forEach(item => {
        item.addEventListener('click', (e) => {
          // Ignore clicks on vote buttons
          const target = e.target as HTMLElement;
          if (target.closest('.outcome-vote-btn')) return;

          const pinName = item.getAttribute('data-pin-name');
          const lat = parseFloat(item.getAttribute('data-lat') || '0');
          const lng = parseFloat(item.getAttribute('data-lng') || '0');

          if (pinName && lat && lng) {
            // Find the pin to get its category
            const pin = config.pins.find(p => p.name === pinName);
            if (!pin) return;

            // Fly to the pin
            map.flyTo([lat, lng], 14, {
              duration: 1.0,
              easeLinearity: 0.25
            });

            // Find the correct marker based on clustering state
            const markers = markersByCategory.get(pin.category) || [];
            const markerPair = markers.find(m => {
              const markerLatLng = m.normal.getLatLng();
              return markerLatLng.lat === lat && markerLatLng.lng === lng;
            });

            if (markerPair) {
              const marker = clusteringEnabled ? markerPair.cluster : markerPair.normal;
              setTimeout(() => {
                marker.openPopup();
              }, 600);
            }
          }
        });
      });

      // Add click handlers for poll vote buttons
      outcomesContent.querySelectorAll('.poll-vote-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const container = btn.closest('.poll-vote-buttons');
          if (!container) return;

          const pollId = container.getAttribute('data-poll-id');
          const vote = btn.getAttribute('data-vote') as VoteTier;
          if (!pollId || !vote) return;

          // Check if removing vote
          const currentVote = userPollVotes.get(pollId);
          const isRemoving = currentVote === vote;

          let success: boolean;
          if (isRemoving) {
            success = await removePollVote(pollId);
          } else {
            success = await submitPollVote(pollId, vote);
          }

          if (success) {
            renderOutcomesTab();
          }
        });
      });

      // Add click handlers for outcome (pin) vote buttons
      outcomesContent.querySelectorAll('.outcome-vote-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const container = btn.closest('.outcome-vote-buttons');
          if (!container) return;

          const pinId = container.getAttribute('data-pin-id');
          const vote = btn.getAttribute('data-vote') as VoteTier;
          if (!pinId || !vote) return;

          // Check if removing vote
          const currentVote = userVotes.get(pinId);
          const isRemoving = currentVote === vote;

          let success: boolean;
          if (isRemoving) {
            success = await removeVote(pinId);
          } else {
            success = await submitVote(pinId, vote);
          }

          if (success) {
            // Update popup/card vote buttons if they're showing this pin
            document.querySelectorAll(`.popup-vote-buttons[data-pin-id="${pinId}"], .card-vote-buttons[data-pin-id="${pinId}"]`).forEach(btnContainer => {
              btnContainer.querySelectorAll('.popup-vote-btn, .card-vote-btn').forEach(voteBtn => {
                voteBtn.classList.remove('active');
                if (!isRemoving && voteBtn.getAttribute('data-vote') === vote) {
                  voteBtn.classList.add('active');
                }
              });
            });

            // Update the marker's stored popup content so it shows correctly when opened
            const markerData = markersByPinId.get(pinId);
            if (markerData) {
              const newPopupContent = createPopupContent(markerData.pin);
              markerData.cluster.setPopupContent(newPopupContent);
              markerData.normal.setPopupContent(newPopupContent);
            }

            renderOutcomesTab();
          }
        });
      });

      // Add poll button handler
      const addPollBtn = outcomesContent.querySelector('#add-poll-btn');
      if (addPollBtn) {
        addPollBtn.addEventListener('click', () => {
          showAddPollModal();
        });
      }

      // Change group button handler
      const changeGroupBtn = outcomesContent.querySelector('#change-group-btn');
      if (changeGroupBtn) {
        changeGroupBtn.addEventListener('click', () => {
          showGroupsModal();
        });
      }

      // Delete poll button handlers (admin only)
      outcomesContent.querySelectorAll('.poll-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const pollId = btn.getAttribute('data-poll-id');
          if (!pollId) return;

          if (confirm('Delete this question? All votes will be lost.')) {
            const success = await deletePoll(pollId);
            if (success) {
              renderOutcomesTab();
            }
          }
        });
      });
    }

    // Add poll modal
    function showAddPollModal() {
      // Create modal
      const modal = document.createElement('div');
      modal.className = 'poll-modal-overlay';
      modal.innerHTML = `
        <div class="poll-modal">
          <div class="poll-modal-header">
            <h3>Add a Question</h3>
            <button class="poll-modal-close">&times;</button>
          </div>
          <div class="poll-modal-body">
            <label>Question</label>
            <input type="text" class="poll-input" id="poll-question-input" placeholder="e.g., Kayaking excursion">
            <label>Description (optional)</label>
            <input type="text" class="poll-input" id="poll-description-input" placeholder="e.g., 2-3 hour guided tour">
          </div>
          <div class="poll-modal-footer">
            <button class="poll-modal-cancel">Cancel</button>
            <button class="poll-modal-submit">Add Question</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      const closeModal = () => modal.remove();

      modal.querySelector('.poll-modal-close')?.addEventListener('click', closeModal);
      modal.querySelector('.poll-modal-cancel')?.addEventListener('click', closeModal);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });

      modal.querySelector('.poll-modal-submit')?.addEventListener('click', async () => {
        const questionInput = modal.querySelector('#poll-question-input') as HTMLInputElement;
        const descriptionInput = modal.querySelector('#poll-description-input') as HTMLInputElement;

        const question = questionInput.value.trim();
        const description = descriptionInput.value.trim();

        if (!question) {
          questionInput.focus();
          return;
        }

        const success = await createPoll(question, description);
        if (success) {
          closeModal();
          renderOutcomesTab();
        }
      });

      // Focus the input
      setTimeout(() => {
        (modal.querySelector('#poll-question-input') as HTMLInputElement)?.focus();
      }, 100);
    }

    // Groups management modal
    async function showGroupsModal() {
      const modal = document.createElement('div');
      modal.className = 'poll-modal-overlay groups-modal-overlay';

      async function renderModalContent() {
        // Reload groups to get fresh data
        await loadGroups();

        let myGroupsHtml = '';
        let pendingHtml = '';
        let browseHtml = '';

        // My Groups section
        if (userGroups.length > 0) {
          myGroupsHtml = userGroups.map(group => {
            const isCurrentGroup = currentGroup?.id === group.id;
            const membership = userGroupMemberships.get(group.id);
            const isGroupAdminRole = membership?.role === 'admin';
            const canManage = isGroupAdminRole || isAdmin; // Site admins can manage any group

            return `
              <div class="group-item ${isCurrentGroup ? 'current' : ''}" data-group-id="${group.id}">
                <div class="group-item-info">
                  <div class="group-item-name">${group.name}${isGroupAdminRole ? ' <span class="group-admin-badge">Admin</span>' : ''}${isAdmin && !isGroupAdminRole ? ' <span class="group-admin-badge">Site Admin</span>' : ''}</div>
                  ${group.description ? `<div class="group-item-desc">${group.description}</div>` : ''}
                </div>
                <div class="group-item-actions">
                  ${!isCurrentGroup ? `<button class="group-select-btn" data-group-id="${group.id}">Select</button>` : '<span class="group-current-badge">Current</span>'}
                  ${canManage ? `<button class="group-manage-btn" data-group-id="${group.id}">Manage</button>` : ''}
                  <button class="group-leave-btn" data-group-id="${group.id}">Leave</button>
                </div>
              </div>
            `;
          }).join('');
        } else {
          myGroupsHtml = '<p class="groups-empty">You are not a member of any groups yet.</p>';
        }

        // Pending Requests section
        if (pendingRequests.length > 0) {
          pendingHtml = pendingRequests.map(req => {
            const group = allGroups.find(g => g.id === req.group_id);
            return `
              <div class="group-item pending">
                <div class="group-item-info">
                  <div class="group-item-name">${group?.name || 'Unknown Group'}</div>
                  <div class="group-item-status">Pending approval</div>
                </div>
              </div>
            `;
          }).join('');
        }

        // Browse Groups section (groups user is not a member of, or was denied)
        const availableGroups = allGroups.filter(g => {
          const membership = userGroupMemberships.get(g.id);
          return !membership || membership.status === 'denied';
        });
        if (availableGroups.length > 0) {
          browseHtml = availableGroups.map(group => `
            <div class="group-item" data-group-id="${group.id}">
              <div class="group-item-info">
                <div class="group-item-name">${group.name}</div>
                ${group.description ? `<div class="group-item-desc">${group.description}</div>` : ''}
              </div>
              <div class="group-item-actions">
                ${isAdmin ? `<button class="group-manage-btn" data-group-id="${group.id}">Manage</button>` : ''}
                <button class="group-join-btn" data-group-id="${group.id}">Request to Join</button>
              </div>
            </div>
          `).join('');
        } else {
          browseHtml = '<p class="groups-empty">No other groups available.</p>';
        }

        modal.innerHTML = `
          <div class="poll-modal groups-modal">
            <div class="poll-modal-header">
              <h3>Manage Groups</h3>
              <button class="poll-modal-close">&times;</button>
            </div>
            <div class="poll-modal-body groups-modal-body">
              <div class="groups-section">
                <h4>My Profile</h4>
                <div class="profile-edit-form">
                  <label>Display Name</label>
                  <div class="profile-edit-row">
                    <input type="text" id="display-name-input" class="poll-input" value="${currentProfile?.display_name || ''}" placeholder="Your display name">
                    <button class="group-select-btn" id="save-display-name-btn">Save</button>
                  </div>
                </div>
              </div>
              <div class="groups-section">
                <h4>My Groups</h4>
                <div class="groups-list">${myGroupsHtml}</div>
              </div>
              ${pendingHtml ? `
                <div class="groups-section">
                  <h4>Pending Requests</h4>
                  <div class="groups-list">${pendingHtml}</div>
                </div>
              ` : ''}
              <div class="groups-section">
                <h4>Browse Groups</h4>
                <div class="groups-list">${browseHtml}</div>
              </div>
              <div class="groups-section">
                <h4>Create New Group</h4>
                <div class="groups-create-form">
                  <input type="text" id="new-group-name" class="poll-input" placeholder="Group name">
                  <input type="text" id="new-group-desc" class="poll-input" placeholder="Description (optional)">
                  <button class="poll-modal-submit" id="create-group-btn">Create Group</button>
                </div>
              </div>
            </div>
          </div>
        `;

        // Add event listeners
        const closeModal = () => modal.remove();
        modal.querySelector('.poll-modal-close')?.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
          if (e.target === modal) closeModal();
        });

        // Save display name button
        modal.querySelector('#save-display-name-btn')?.addEventListener('click', async () => {
          const input = modal.querySelector('#display-name-input') as HTMLInputElement;
          const newName = input.value.trim();
          if (newName) {
            const success = await updateDisplayName(newName);
            if (success) {
              alert('Display name updated!');
            }
          }
        });

        // Select group buttons
        modal.querySelectorAll('.group-select-btn[data-group-id]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const groupId = btn.getAttribute('data-group-id');
            if (groupId) {
              switchGroup(groupId);
              await loadVotes();
              await loadPolls();
              renderSidePanel();
              renderOutcomesTab();
              await renderModalContent();
            }
          });
        });

        // Leave group buttons
        modal.querySelectorAll('.group-leave-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const groupId = btn.getAttribute('data-group-id');
            if (groupId && confirm('Leave this group? Your votes in this group will be deleted.')) {
              await leaveGroup(groupId);
              await loadVotes();
              await loadPolls();
              renderSidePanel();
              renderOutcomesTab();
              await renderModalContent();
            }
          });
        });

        // Manage group buttons
        modal.querySelectorAll('.group-manage-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const groupId = btn.getAttribute('data-group-id');
            if (groupId) {
              closeModal();
              await showManageGroupModal(groupId);
            }
          });
        });

        // Request to join buttons
        modal.querySelectorAll('.group-join-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const groupId = btn.getAttribute('data-group-id');
            if (groupId) {
              const success = await requestJoinGroup(groupId);
              if (success) {
                await renderModalContent();
              }
            }
          });
        });

        // Create group button
        modal.querySelector('#create-group-btn')?.addEventListener('click', async () => {
          const nameInput = modal.querySelector('#new-group-name') as HTMLInputElement;
          const descInput = modal.querySelector('#new-group-desc') as HTMLInputElement;
          const name = nameInput.value.trim();
          const description = descInput.value.trim();

          if (!name) {
            nameInput.focus();
            return;
          }

          const group = await createGroup(name, description);
          if (group) {
            // Switch to the new group
            switchGroup(group.id);
            await loadVotes();
            await loadPolls();
            renderSidePanel();
            renderOutcomesTab();
            await renderModalContent();
          }
        });
      }

      document.body.appendChild(modal);
      await renderModalContent();
    }

    // Manage group modal (for admins)
    async function showManageGroupModal(groupId: string) {
      // Site admins can manage any group, regular users only their own
      const group = allGroups.find(g => g.id === groupId) || userGroups.find(g => g.id === groupId);
      if (!group) return;

      const modal = document.createElement('div');
      modal.className = 'poll-modal-overlay groups-modal-overlay';

      async function renderManageContent() {
        const members = await loadGroupMembers(groupId);
        const pendingMembers = members.filter(m => m.status === 'pending');
        const approvedMembers = members.filter(m => m.status === 'approved');

        // Load profiles for all members to show display names
        await loadProfilesForUsers(members.map(m => m.user_id));

        let pendingHtml = '';
        if (pendingMembers.length > 0) {
          pendingHtml = pendingMembers.map(member => `
            <div class="member-item pending" data-member-id="${member.id}">
              <div class="member-info">
                <span class="member-name">${getDisplayName(member.user_id)}</span>
                <span class="member-status">Pending</span>
              </div>
              <div class="member-actions">
                <button class="member-approve-btn" data-member-id="${member.id}">Approve</button>
                <button class="member-deny-btn" data-member-id="${member.id}">Deny</button>
              </div>
            </div>
          `).join('');
        } else {
          pendingHtml = '<p class="groups-empty">No pending requests.</p>';
        }

        let membersHtml = approvedMembers.map(member => `
          <div class="member-item" data-member-id="${member.id}">
            <div class="member-info">
              <span class="member-name">${getDisplayName(member.user_id)}</span>
              <span class="member-role ${member.role}">${member.role}</span>
            </div>
            ${member.user_id !== currentUserId ? `
              <div class="member-actions">
                <button class="member-remove-btn" data-member-id="${member.id}">Remove</button>
              </div>
            ` : ''}
          </div>
        `).join('');

        modal.innerHTML = `
          <div class="poll-modal groups-modal">
            <div class="poll-modal-header">
              <h3>Manage: ${group!.name}</h3>
              <button class="poll-modal-close">&times;</button>
            </div>
            <div class="poll-modal-body groups-modal-body">
              <div class="groups-section">
                <h4>Pending Requests (${pendingMembers.length})</h4>
                <div class="members-list">${pendingHtml}</div>
              </div>
              <div class="groups-section">
                <h4>Members (${approvedMembers.length})</h4>
                <div class="members-list">${membersHtml}</div>
              </div>
              <div class="groups-section danger-zone">
                <h4>Danger Zone</h4>
                <button class="group-delete-btn" id="delete-group-btn">Delete Group</button>
              </div>
            </div>
            <div class="poll-modal-footer">
              <button class="poll-modal-cancel" id="back-to-groups-btn">Back to Groups</button>
            </div>
          </div>
        `;

        // Add event listeners
        const closeModal = () => modal.remove();
        modal.querySelector('.poll-modal-close')?.addEventListener('click', closeModal);

        modal.querySelector('#back-to-groups-btn')?.addEventListener('click', () => {
          closeModal();
          showGroupsModal();
        });

        // Approve buttons
        modal.querySelectorAll('.member-approve-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const memberId = btn.getAttribute('data-member-id');
            if (memberId) {
              await approveJoinRequest(memberId);
              await renderManageContent();
            }
          });
        });

        // Deny buttons
        modal.querySelectorAll('.member-deny-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const memberId = btn.getAttribute('data-member-id');
            if (memberId) {
              await denyJoinRequest(memberId);
              await renderManageContent();
            }
          });
        });

        // Remove buttons
        modal.querySelectorAll('.member-remove-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const memberId = btn.getAttribute('data-member-id');
            if (memberId && confirm('Remove this member from the group?')) {
              await removeMember(memberId);
              await renderManageContent();
            }
          });
        });

        // Delete group button
        modal.querySelector('#delete-group-btn')?.addEventListener('click', async () => {
          if (confirm(`Delete "${group!.name}"? This will remove all votes and cannot be undone.`)) {
            const success = await deleteGroup(groupId);
            if (success) {
              closeModal();
              await loadVotes();
              await loadPolls();
              renderSidePanel();
              renderOutcomesTab();
            }
          }
        });
      }

      document.body.appendChild(modal);
      await renderManageContent();
    }

    // Tab switching
    panelTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.getAttribute('data-tab');

        // Update active tab
        panelTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Show/hide content
        if (tabName === 'locations') {
          panelContent.style.display = '';
          outcomesContent.style.display = 'none';
        } else if (tabName === 'outcomes') {
          panelContent.style.display = 'none';
          outcomesContent.style.display = '';
          renderOutcomesTab();
        }
      });
    });

    // Set up real-time subscriptions for live vote updates
    setupRealtimeSubscriptions(
      // On votes change: update all marker popups and refresh outcomes tab
      () => {
        // Update all marker popup contents
        markersByPinId.forEach((data) => {
          const newContent = createPopupContent(data.pin);
          data.cluster.setPopupContent(newContent);
          data.normal.setPopupContent(newContent);
        });
        // Refresh outcomes tab if visible
        renderOutcomesTab();
      },
      // On poll votes change: refresh outcomes tab
      () => {
        renderOutcomesTab();
      }
    );

    // Category toggle handler
    function toggleCategory(categoryName: string) {
      if (activeCategories.has(categoryName)) {
        activeCategories.delete(categoryName);
      } else {
        activeCategories.add(categoryName);
      }
      updateVisibleMarkers();
      renderSidePanel(); // Update side panel when categories change

      // Update hike routes when Hike category changes
      if (categoryName === 'Hike') {
        updateHikeRoutes();
      }
    }

    // Render legend with click handlers
    renderLegend(config.categories, activeCategories, toggleCategory);

    // Hike mode functionality
    const hikeModeBtn = document.getElementById('hike-mode-btn');
    const hikeFilterPanel = document.getElementById('hike-filter-panel')!;
    const filterContent = document.getElementById('filter-content')!;
    const filterCloseBtn = document.getElementById('filter-close-btn')!;
    const mobileFilterContainer = document.getElementById('mobile-filter-container')!;

    // Calculate min/max values for hikes
    const hikes = config.pins.filter(p => p.category === 'Hike' && p.distance && p.elevation_gain);
    const distances = hikes.map(h => h.distance!);
    const elevations = hikes.map(h => h.elevation_gain!);

    const minDistance = distances.length > 0 ? Math.min(...distances) : 0;
    const maxDistance = distances.length > 0 ? Math.max(...distances) : 100;
    const minElevation = elevations.length > 0 ? Math.min(...elevations) : 0;
    const maxElevation = elevations.length > 0 ? Math.max(...elevations) : 10000;

    // Initialize filter ranges with actual values
    currentMinDistance = minDistance;
    currentMaxDistance = maxDistance;
    currentMinElevation = minElevation;
    currentMaxElevation = maxElevation;

    function renderFilterPanel() {
      filterContent.innerHTML = `
        <div class="filter-group">
          <div class="filter-label">
            <span>Distance</span>
            <span class="filter-value" id="distance-value">${currentMinDistance.toFixed(1)} - ${currentMaxDistance.toFixed(1)} mi</span>
          </div>
          <div class="dual-range">
            <div class="range-track"></div>
            <div class="range-fill" id="distance-fill"></div>
            <input type="range" id="distance-min" class="filter-slider" min="${minDistance}" max="${maxDistance}" step="0.1" value="${currentMinDistance}">
            <input type="range" id="distance-max" class="filter-slider" min="${minDistance}" max="${maxDistance}" step="0.1" value="${currentMaxDistance}">
          </div>
        </div>
        <div class="filter-group">
          <div class="filter-label">
            <span>Elevation Gain</span>
            <span class="filter-value" id="elevation-value">${Math.round(currentMinElevation)} - ${Math.round(currentMaxElevation)} ft</span>
          </div>
          <div class="dual-range">
            <div class="range-track"></div>
            <div class="range-fill" id="elevation-fill"></div>
            <input type="range" id="elevation-min" class="filter-slider" min="${minElevation}" max="${maxElevation}" step="10" value="${currentMinElevation}">
            <input type="range" id="elevation-max" class="filter-slider" min="${minElevation}" max="${maxElevation}" step="10" value="${currentMaxElevation}">
          </div>
        </div>
      `;

      // Setup range sliders
      setupRangeSlider('distance', minDistance, maxDistance, (min, max) => {
        currentMinDistance = min;
        currentMaxDistance = max;
        filterHikes();
      });

      setupRangeSlider('elevation', minElevation, maxElevation, (min, max) => {
        currentMinElevation = min;
        currentMaxElevation = max;
        filterHikes();
      });
    }

    function setupRangeSlider(id: string, min: number, max: number, onChange: (min: number, max: number) => void) {
      const minSlider = document.getElementById(`${id}-min`) as HTMLInputElement;
      const maxSlider = document.getElementById(`${id}-max`) as HTMLInputElement;
      const valueDisplay = document.getElementById(`${id}-value`)!;
      const fill = document.getElementById(`${id}-fill`)!;

      function updateValue() {
        let minVal = parseFloat(minSlider.value);
        let maxVal = parseFloat(maxSlider.value);

        if (minVal > maxVal) {
          [minVal, maxVal] = [maxVal, minVal];
          minSlider.value = minVal.toString();
          maxSlider.value = maxVal.toString();
        }

        // Update display
        if (id === 'distance') {
          valueDisplay.textContent = `${minVal.toFixed(1)} - ${maxVal.toFixed(1)} mi`;
        } else {
          valueDisplay.textContent = `${Math.round(minVal)} - ${Math.round(maxVal)} ft`;
        }

        // Update fill bar
        const percentMin = ((minVal - min) / (max - min)) * 100;
        const percentMax = ((maxVal - min) / (max - min)) * 100;
        fill.style.left = `${percentMin}%`;
        fill.style.width = `${percentMax - percentMin}%`;

        onChange(minVal, maxVal);
      }

      minSlider.addEventListener('input', updateValue);
      maxSlider.addEventListener('input', updateValue);
      updateValue();
    }

    function filterHikes() {
      // Update visible markers (which now respects hike filters)
      updateVisibleMarkers();

      // Update side panel if open
      if (sidePanel.classList.contains('open')) {
        renderSidePanel();
      }
    }

    function toggleHikeMode() {
      hikeModeActive = !hikeModeActive;

      if (hikeModeActive) {
        // Activate hike mode
        hikeModeBtn?.classList.add('active');

        // Save current category selection before entering hike mode
        preHikeModeCategories = new Set(activeCategories);

        // Hide all non-hike categories
        config.categories.forEach(cat => {
          if (cat.name !== 'Hike') {
            activeCategories.delete(cat.name);
          } else {
            activeCategories.add(cat.name);
          }
        });

        // Show filter panel
        const isMobile = window.innerWidth <= 768;
        const sidePanelOpen = sidePanel.classList.contains('open');

        // On mobile, automatically open side panel for hike mode
        if (isMobile && !sidePanelOpen) {
          sidePanel.classList.add('open');
          mapElement.classList.add('panel-open');
          renderSidePanel();
          legendElement.classList.add('hidden');
          showLegendBtn.classList.add('visible');

          // Invalidate map size after transition
          setTimeout(() => {
            map.invalidateSize();
          }, 350);
        }

        if (isMobile) {
          // On mobile, show in mobile container
          mobileFilterContainer.classList.remove('empty');
          mobileFilterContainer.appendChild(hikeFilterPanel);
        } else {
          // On desktop, show as overlay
          document.body.appendChild(hikeFilterPanel);
        }

        hikeFilterPanel.classList.add('visible');
        legendElement.classList.add('hidden');

        // Render filter panel
        renderFilterPanel();

        // Update visible markers
        updateVisibleMarkers();

        // Update hike routes (show only hikes now)
        updateHikeRoutes();

        // Update legend visual state
        document.querySelectorAll('.legend-item').forEach(item => {
          const category = item.getAttribute('data-category');
          if (category !== 'Hike') {
            item.classList.add('inactive');
          } else {
            item.classList.remove('inactive');
          }
        });
      } else {
        // Deactivate hike mode
        hikeModeBtn?.classList.remove('active');
        hikeFilterPanel.classList.remove('visible');
        legendElement.classList.remove('hidden');
        showLegendBtn.classList.remove('visible');
        mobileFilterContainer.classList.add('empty');

        // Restore previous category selection
        if (preHikeModeCategories) {
          activeCategories.clear();
          preHikeModeCategories.forEach(cat => activeCategories.add(cat));
          preHikeModeCategories = null;
        } else {
          // Fallback: restore all categories except Mountains
          config.categories.forEach(cat => {
            if (cat.name !== 'Mountains') {
              activeCategories.add(cat.name);
            }
          });
        }

        // Reset filter values
        currentMinDistance = minDistance;
        currentMaxDistance = maxDistance;
        currentMinElevation = minElevation;
        currentMaxElevation = maxElevation;

        // Update visible markers
        updateVisibleMarkers();

        // Update hike routes
        updateHikeRoutes();

        // Update legend visual state to match restored categories
        document.querySelectorAll('.legend-item').forEach(item => {
          const category = item.getAttribute('data-category');
          if (category && activeCategories.has(category)) {
            item.classList.remove('inactive');
          } else {
            item.classList.add('inactive');
          }
        });
      }

      // Update side panel if open
      if (sidePanel.classList.contains('open')) {
        renderSidePanel();
      }
    }

    if (hikeModeBtn) {
      hikeModeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleHikeMode();
      });
    }

    filterCloseBtn.addEventListener('click', () => {
      if (hikeModeActive) {
        toggleHikeMode();
      }
    });

    // Legend hide/show functionality
    const legendElement = document.getElementById('legend')!;
    const legendHideBtn = document.getElementById('legend-hide-btn')!;
    const showLegendBtn = document.getElementById('show-legend-btn')!;

    legendHideBtn.addEventListener('click', () => {
      legendElement.classList.add('hidden');
      showLegendBtn.classList.add('visible');
    });

    showLegendBtn.addEventListener('click', () => {
      legendElement.classList.remove('hidden');
      showLegendBtn.classList.remove('visible');
    });

    // Panel toggle button
    panelToggle.addEventListener('click', () => {
      const isOpen = sidePanel.classList.contains('open');
      const isMobile = window.innerWidth <= 768;

      if (isOpen) {
        sidePanel.classList.remove('open');
        mapElement.classList.remove('panel-open');
        // Don't change legend state when closing - maintain current state

        // Exit hike mode when closing panel on mobile
        if (isMobile && hikeModeActive) {
          toggleHikeMode();
        }
      } else {
        sidePanel.classList.add('open');
        mapElement.classList.add('panel-open');
        renderSidePanel(); // Refresh content

        // Hide legend by default when panel opens on mobile (first time only)
        if (isMobile) {
          legendElement.classList.add('hidden');
          showLegendBtn.classList.add('visible');
        }
      }

      // Invalidate map size after transition completes
      setTimeout(() => {
        map.invalidateSize();
      }, 350);
    });

    // Panel close button
    panelClose.addEventListener('click', () => {
      const isMobile = window.innerWidth <= 768;

      sidePanel.classList.remove('open');
      mapElement.classList.remove('panel-open');
      // Don't change legend state when closing - maintain current state

      // Exit hike mode when closing panel on mobile
      if (isMobile && hikeModeActive) {
        toggleHikeMode();
      }

      // Invalidate map size after transition completes
      setTimeout(() => {
        map.invalidateSize();
      }, 350);
    });

    // Search functionality
    const searchInput = document.getElementById('search-input') as HTMLInputElement;
    const searchClear = document.getElementById('search-clear')!;
    const searchResults = document.getElementById('search-results')!;

    searchInput.addEventListener('input', () => {
      const query = searchInput.value.toLowerCase().trim();

      // Toggle clear button visibility
      searchClear.classList.toggle('visible', query.length > 0);

      if (!query) {
        searchResults.classList.remove('visible');
        searchResults.innerHTML = '';
        return;
      }

      // Search pins by name, description, and category
      const matches = config.pins.filter(pin =>
        pin.name.toLowerCase().includes(query) ||
        pin.description.toLowerCase().includes(query) ||
        pin.category.toLowerCase().includes(query)
      );

      if (matches.length === 0) {
        searchResults.innerHTML = '<div class="search-no-results">No results found</div>';
        searchResults.classList.add('visible');
        return;
      }

      // Render results
      searchResults.innerHTML = '';
      matches.slice(0, 10).forEach(pin => { // Limit to 10 results
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.innerHTML = `
          <div class="search-result-name">${pin.name}</div>
          <div class="search-result-category">${pin.category}</div>
        `;
        item.addEventListener('click', () => {
          // Fly to the pin
          map.flyTo([pin.coordinates[0], pin.coordinates[1]], 15, {
            duration: 0.8
          });

          // Find and open the marker popup
          const marker = pinMarkers.get(pin.name);
          if (marker) {
            setTimeout(() => {
              marker.openPopup();
            }, 800);
          }

          // Clear search
          searchInput.value = '';
          searchClear.classList.remove('visible');
          searchResults.classList.remove('visible');
          searchResults.innerHTML = '';
        });
        searchResults.appendChild(item);
      });

      searchResults.classList.add('visible');
    });

    // Clear search
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.classList.remove('visible');
      searchResults.classList.remove('visible');
      searchResults.innerHTML = '';
    });

    // Close results when clicking outside
    document.addEventListener('click', (e) => {
      const container = document.getElementById('search-container')!;
      if (!container.contains(e.target as Node)) {
        searchResults.classList.remove('visible');
      }
    });

    // Routing functionality
    const routePanel = document.getElementById('route-panel')!;
    const routePanelClose = document.getElementById('route-panel-close')!;
    const drivingTimeToggle = document.getElementById('driving-time-toggle')!;
    const routeStartInput = document.getElementById('route-start-input') as HTMLInputElement;
    const routeEndInput = document.getElementById('route-end-input') as HTMLInputElement;
    const routeStartSuggestions = document.getElementById('route-start-suggestions')!;
    const routeEndSuggestions = document.getElementById('route-end-suggestions')!;
    const routeClearStart = document.getElementById('route-clear-start')!;
    const routeClearEnd = document.getElementById('route-clear-end')!;
    const routeResult = document.getElementById('route-result')!;
    const routePickStart = document.getElementById('route-pick-start')!;
    const routePickEnd = document.getElementById('route-pick-end')!;

    let selectedStartPin: string = '';
    let selectedEndPin: string = '';
    let focusedInput: 'start' | 'end' | null = null;
    let pickMode: 'start' | 'end' | null = null;
    let pickModeBanner: HTMLElement | null = null;

    // Track which input is focused
    routeStartInput.addEventListener('focus', () => {
      focusedInput = 'start';
    });

    routeEndInput.addEventListener('focus', () => {
      focusedInput = 'end';
    });

    routeStartInput.addEventListener('blur', () => {
      // Delay clearing focus to allow click events to process
      setTimeout(() => {
        if (focusedInput === 'start') focusedInput = null;
      }, 200);
    });

    routeEndInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (focusedInput === 'end') focusedInput = null;
      }, 200);
    });

    // Set default to "Jesse's House" if it exists
    const jessesHouse = config.pins.find(p => p.name === "Jesse's House");
    if (jessesHouse) {
      routeStartInput.value = "Jesse's House";
      selectedStartPin = "Jesse's House";
      routeClearStart.classList.add('visible');
    }

    // Autocomplete functionality
    function setupAutocomplete(input: HTMLInputElement, suggestionsEl: HTMLElement, onSelect: (pinName: string) => void) {
      input.addEventListener('input', () => {
        const query = input.value.toLowerCase().trim();

        if (!query) {
          suggestionsEl.classList.remove('visible');
          suggestionsEl.innerHTML = '';
          return;
        }

        // Substring matching
        const matches = config.pins.filter(pin =>
          pin.name.toLowerCase().includes(query)
        );

        if (matches.length === 0) {
          suggestionsEl.classList.remove('visible');
          suggestionsEl.innerHTML = '';
          return;
        }

        // Render suggestions
        suggestionsEl.innerHTML = '';
        matches.forEach(pin => {
          const item = document.createElement('div');
          item.className = 'route-suggestion-item';
          item.textContent = pin.name;
          item.addEventListener('click', () => {
            input.value = pin.name;
            onSelect(pin.name);
            suggestionsEl.classList.remove('visible');
            suggestionsEl.innerHTML = '';
          });
          suggestionsEl.appendChild(item);
        });

        suggestionsEl.classList.add('visible');
      });

      // Close suggestions when clicking outside
      document.addEventListener('click', (e) => {
        if (!input.contains(e.target as Node) && !suggestionsEl.contains(e.target as Node)) {
          suggestionsEl.classList.remove('visible');
        }
      });
    }

    setupAutocomplete(routeStartInput, routeStartSuggestions, (pinName) => {
      selectedStartPin = pinName;
      routeClearStart.classList.add('visible');
      calculateRoute();
    });

    setupAutocomplete(routeEndInput, routeEndSuggestions, (pinName) => {
      selectedEndPin = pinName;
      routeClearEnd.classList.add('visible');
      calculateRoute();
    });

    // Pick from map functionality
    function enterPickMode(mode: 'start' | 'end') {
      pickMode = mode;
      const isMobile = window.innerWidth <= 768;

      // Update button states
      routePickStart.classList.toggle('active', mode === 'start');
      routePickEnd.classList.toggle('active', mode === 'end');

      // Create and show banner
      if (!pickModeBanner) {
        pickModeBanner = document.createElement('div');
        pickModeBanner.className = 'route-pick-mode-banner';
        document.body.appendChild(pickModeBanner);
      }

      const label = mode === 'start' ? 'Start' : 'Destination';
      pickModeBanner.innerHTML = `Tap a pin to set as ${label} <button id="cancel-pick-mode">Cancel</button>`;
      pickModeBanner.style.display = 'block';

      document.getElementById('cancel-pick-mode')!.addEventListener('click', exitPickMode);

      // On mobile, minimize the route panel to show more map
      if (isMobile) {
        routePanel.classList.remove('open');
        mapElement.classList.remove('route-panel-open');
        setTimeout(() => map.invalidateSize(), 350);
      }
    }

    function exitPickMode() {
      pickMode = null;
      routePickStart.classList.remove('active');
      routePickEnd.classList.remove('active');

      if (pickModeBanner) {
        pickModeBanner.style.display = 'none';
      }

      // On mobile, reopen the route panel
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        routePanel.classList.add('open');
        mapElement.classList.add('route-panel-open');
        setTimeout(() => map.invalidateSize(), 350);
      }
    }

    function handlePickModeSelection(pinName: string) {
      if (!pickMode) return;

      if (pickMode === 'start') {
        routeStartInput.value = pinName;
        selectedStartPin = pinName;
        routeClearStart.classList.add('visible');
      } else {
        routeEndInput.value = pinName;
        selectedEndPin = pinName;
        routeClearEnd.classList.add('visible');
      }

      exitPickMode();
      calculateRoute();
    }

    // Pick button click handlers
    routePickStart.addEventListener('click', () => {
      if (pickMode === 'start') {
        exitPickMode();
      } else {
        enterPickMode('start');
      }
    });

    routePickEnd.addEventListener('click', () => {
      if (pickMode === 'end') {
        exitPickMode();
      } else {
        enterPickMode('end');
      }
    });

    function clearRoute() {
      if (routingControl) {
        map.removeControl(routingControl);
        routingControl = null;
      }
      routeResult.classList.remove('visible');
    }

    function calculateRoute() {
      const startName = selectedStartPin;
      const endName = selectedEndPin;

      if (!startName || !endName) {
        clearRoute();
        return;
      }

      const startPin = config.pins.find(p => p.name === startName);
      const endPin = config.pins.find(p => p.name === endName);

      if (!startPin || !endPin) {
        clearRoute();
        return;
      }

      // Clear existing route
      if (routingControl) {
        map.removeControl(routingControl);
      }

      // Create routing control
      routingControl = L.Routing.control({
        waypoints: [
          L.latLng(startPin.coordinates[0], startPin.coordinates[1]),
          L.latLng(endPin.coordinates[0], endPin.coordinates[1])
        ],
        router: L.Routing.osrmv1({
          serviceUrl: 'https://router.project-osrm.org/route/v1'
        }),
        show: false, // Hide the default instructions panel
        addWaypoints: false,
        routeWhileDragging: false,
        fitSelectedRoutes: true,
        lineOptions: {
          styles: [{ color: '#3498db', weight: 4, opacity: 0.7 }],
          extendToWaypoints: true,
          missingRouteTolerance: 0
        }
      }).addTo(map);

      // Listen for route found event
      routingControl.on('routesfound', (e: any) => {
        const routes = e.routes;
        if (routes && routes.length > 0) {
          const route = routes[0];
          const distanceMiles = (route.summary.totalDistance / 1609.34).toFixed(1);
          const timeMinutes = Math.round(route.summary.totalTime / 60);
          const hours = Math.floor(timeMinutes / 60);
          const mins = timeMinutes % 60;

          let timeStr = '';
          if (hours > 0) {
            timeStr = `${hours}h ${mins}min`;
          } else {
            timeStr = `${mins}min`;
          }

          routeResult.innerHTML = `<div class="route-result-text"><strong>${startPin.name}</strong> → <strong>${endPin.name}</strong><br>${distanceMiles} mi • ${timeStr} drive</div>`;
          routeResult.classList.add('visible');
        }
      });
    }

    // Toggle driving time panel
    drivingTimeToggle.addEventListener('click', () => {
      const isOpen = routePanel.classList.contains('open');

      if (isOpen) {
        routePanel.classList.remove('open');
        drivingTimeToggle.classList.remove('active');
        mapElement.classList.remove('route-panel-open');
        clearRoute();

        // Restore legend visibility when closing route panel
        legendElement.classList.remove('hidden');
        showLegendBtn.classList.remove('visible');
      } else {
        routePanel.classList.add('open');
        drivingTimeToggle.classList.add('active');
        mapElement.classList.add('route-panel-open');

        // Hide legend and Show Legend button when driving time panel opens
        legendElement.classList.add('hidden');
        showLegendBtn.classList.remove('visible');

        // Calculate route if both selections exist
        if (selectedStartPin && selectedEndPin) {
          calculateRoute();
        }
      }

      // Invalidate map size after transition
      setTimeout(() => {
        map.invalidateSize();
      }, 350);
    });

    routePanelClose.addEventListener('click', () => {
      routePanel.classList.remove('open');
      drivingTimeToggle.classList.remove('active');
      mapElement.classList.remove('route-panel-open');
      clearRoute();

      // Restore legend visibility when closing route panel
      legendElement.classList.remove('hidden');
      showLegendBtn.classList.remove('visible');

      // Invalidate map size after transition
      setTimeout(() => {
        map.invalidateSize();
      }, 350);
    });

    // Clear button handlers
    routeClearStart.addEventListener('click', () => {
      routeStartInput.value = '';
      selectedStartPin = '';
      routeClearStart.classList.remove('visible');
      clearRoute();
    });

    routeClearEnd.addEventListener('click', () => {
      routeEndInput.value = '';
      selectedEndPin = '';
      routeClearEnd.classList.remove('visible');
      clearRoute();
    });

    // Highlight card when marker is clicked
    map.on('popupopen', (e: L.PopupEvent) => {
      const markerLatLng = e.popup.getLatLng();
      if (!markerLatLng) return;

      // Find which pin this is
      const pin = config.pins.find(p =>
        p.coordinates[0] === markerLatLng.lat && p.coordinates[1] === markerLatLng.lng
      );

      if (pin) {
        // If in pick mode, handle the selection
        if (pickMode) {
          handlePickModeSelection(pin.name);
          map.closePopup(); // Close the popup after selection
          return;
        }

        // If route panel is open and an input is focused, fill it with the clicked pin
        const isRoutePanelOpen = routePanel.classList.contains('open');
        if (isRoutePanelOpen && focusedInput) {
          if (focusedInput === 'start') {
            routeStartInput.value = pin.name;
            selectedStartPin = pin.name;
            routeClearStart.classList.add('visible');
            routeStartSuggestions.classList.remove('visible');
            calculateRoute();
          } else if (focusedInput === 'end') {
            routeEndInput.value = pin.name;
            selectedEndPin = pin.name;
            routeClearEnd.classList.add('visible');
            routeEndSuggestions.classList.remove('visible');
            calculateRoute();
          }
          return; // Don't proceed with card highlighting
        }
        // Highlight corresponding card
        document.querySelectorAll('.location-card').forEach(c => c.classList.remove('active'));
        const card = document.querySelector(`.location-card[data-pin-name="${pin.name}"]`);
        if (card) {
          card.classList.add('active');
          // Scroll card into view if panel is open
          if (sidePanel.classList.contains('open')) {
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }

      }
    });

    // Handle vote button clicks (event delegation) - works for both popup and card buttons
    document.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;

      // Check if it's a popup vote button or card vote button
      const isPopupBtn = target.classList.contains('popup-vote-btn');
      const isCardBtn = target.classList.contains('card-vote-btn');

      if (!isPopupBtn && !isCardBtn) return;

      e.stopPropagation();

      const container = target.closest('.popup-vote-buttons, .card-vote-buttons');
      if (!container) return;

      const pinId = container.getAttribute('data-pin-id');
      const vote = target.getAttribute('data-vote') as VoteTier;

      if (!pinId || !vote) return;

      // Check if clicking on already-active vote (to remove it)
      const currentVote = userVotes.get(pinId);
      const isRemoving = currentVote === vote;

      let success: boolean;
      if (isRemoving) {
        success = await removeVote(pinId);
      } else {
        success = await submitVote(pinId, vote);
      }

      if (success) {
        // Update all vote buttons for this pin (both popup and cards)
        document.querySelectorAll(`[data-pin-id="${pinId}"]`).forEach(btnContainer => {
          btnContainer.querySelectorAll('.popup-vote-btn, .card-vote-btn').forEach(btn => {
            btn.classList.remove('active');
            if (!isRemoving && btn.getAttribute('data-vote') === vote) {
              btn.classList.add('active');
            }
          });
        });

        // Update all vote summaries for this pin
        const summary = getVoteSummary(pinId);

        // Update popup summary
        const popupContent = document.querySelector('.leaflet-popup-content');
        if (popupContent) {
          let popupSummary = popupContent.querySelector('.popup-vote-summary') as HTMLElement;
          const popupBtnContainer = popupContent.querySelector(`.popup-vote-buttons[data-pin-id="${pinId}"]`);
          if (popupBtnContainer) {
            if (summary.total > 0) {
              if (popupSummary) {
                popupSummary.textContent = `${summary.positive}/${summary.total} interested`;
              } else {
                popupSummary = document.createElement('div');
                popupSummary.className = 'popup-vote-summary';
                popupSummary.textContent = `${summary.positive}/${summary.total} interested`;
                popupBtnContainer.before(popupSummary);
              }
            } else if (popupSummary) {
              popupSummary.remove();
            }
          }
        }

        // Update card summary
        const card = document.querySelector(`.location-card[data-pin-name] .card-vote-buttons[data-pin-id="${pinId}"]`)?.closest('.location-card');
        if (card) {
          let cardSummary = card.querySelector('.card-vote-summary') as HTMLElement;
          const cardVoting = card.querySelector('.card-voting');
          if (cardVoting) {
            if (summary.total > 0) {
              if (cardSummary) {
                cardSummary.textContent = `${summary.positive}/${summary.total} interested`;
              } else {
                cardSummary = document.createElement('div');
                cardSummary.className = 'card-vote-summary';
                cardSummary.textContent = `${summary.positive}/${summary.total} interested`;
                cardVoting.prepend(cardSummary);
              }
            } else if (cardSummary) {
              cardSummary.remove();
            }
          }
        }

        // Refresh outcomes tab if visible
        if (typeof renderOutcomesTab === 'function') {
          renderOutcomesTab();
        }
      }
    });

  } catch (error) {
    console.error('Failed to initialize map:', error);
    alert('Failed to load map configuration. Please check the console for details.');
  }
}

// Auth UI elements
const authScreen = document.getElementById('auth-screen')!;
const appContainer = document.getElementById('app-container')!;
const authForm = document.getElementById('auth-form') as HTMLFormElement;
const authEmail = document.getElementById('auth-email') as HTMLInputElement;
const authPassword = document.getElementById('auth-password') as HTMLInputElement;
const authSubmit = document.getElementById('auth-submit') as HTMLButtonElement;
const authError = document.getElementById('auth-error')!;
const authModeText = document.getElementById('auth-mode-text')!;
const authModeToggle = document.getElementById('auth-mode-toggle')!;
const logoutBtn = document.getElementById('logout-btn')!;

let isSignUp = false;
let mapInitialized = false;

function showApp() {
  authScreen.classList.add('hidden');
  appContainer.classList.remove('hidden');
  if (!mapInitialized) {
    initMap();
    mapInitialized = true;
  }
}

function showAuth() {
  authScreen.classList.remove('hidden');
  appContainer.classList.add('hidden');
  // Reset form state
  authSubmit.disabled = false;
  authError.textContent = '';
  authPassword.value = '';
}

// Toggle between sign in and sign up
authModeToggle.addEventListener('click', () => {
  isSignUp = !isSignUp;
  if (isSignUp) {
    authModeText.textContent = 'Already have an account?';
    authModeToggle.textContent = 'Sign In';
    authSubmit.textContent = 'Sign Up';
  } else {
    authModeText.textContent = "Don't have an account?";
    authModeToggle.textContent = 'Sign Up';
    authSubmit.textContent = 'Sign In';
  }
  authError.textContent = '';
});

// Handle form submission
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!supabase) {
    authError.textContent = 'Auth not configured. Contact admin.';
    return;
  }

  const email = authEmail.value.trim();
  const password = authPassword.value;

  if (!email || !password) {
    authError.textContent = 'Please enter email and password.';
    return;
  }

  authSubmit.disabled = true;
  authError.textContent = '';

  try {
    if (isSignUp) {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: window.location.origin + window.location.pathname,
        },
      });
      if (error) throw error;
      authError.style.color = '#27ae60';
      authError.textContent = 'Check your email to confirm your account!';
      authSubmit.disabled = false;
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      showApp();
    }
  } catch (err: any) {
    authError.style.color = '#e74c3c';
    authError.textContent = err.message || 'Authentication failed.';
    authSubmit.disabled = false;
  }
});

// Handle logout
logoutBtn.addEventListener('click', async () => {
  if (supabase) {
    // Sign out from all devices/tabs to fully clear the session
    await supabase.auth.signOut({ scope: 'global' });
  }
  showAuth();
});

// Initialize: check auth state
async function init() {
  // If Supabase is not configured, skip auth and show the app directly
  if (!supabase) {
    console.warn('Supabase not configured. Showing app without auth.');
    showApp();
    return;
  }

  // Listen for auth state changes first (before checking session)
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      // Clear the hash from URL after successful auth (cleaner URL)
      if (window.location.hash.includes('access_token')) {
        history.replaceState(null, '', window.location.pathname);
      }
      showApp();
    } else {
      showAuth();
    }
  });

  // Handle email confirmation redirect (tokens in URL hash)
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');

  if (accessToken && refreshToken) {
    // Exchange the tokens from the URL for a session
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (!error) {
      // onAuthStateChange will handle showing the app
      return;
    }
  }

  // Check if user is already logged in
  const { data: { session } } = await supabase.auth.getSession();

  if (session) {
    showApp();
  } else {
    showAuth();
  }
}

// Start the app
init();
