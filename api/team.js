function parsePlayer(raw) {
  const trimmed = String(raw || '').trim();
  const [idPart, regionPart] = trimmed.split('@');
  const [name, tag] = (idPart || '').split('#');
  return {
    raw: trimmed,
    name: (name || '').trim(),
    tag: (tag || '').trim(),
    region: (regionPart || 'eu').trim().toLowerCase(),
  };
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getPlayerFromMatch(match, name, tag) {
  const players = match?.players?.all_players || match?.players || [];
  return players.find((p) =>
    String(p?.name || '').toLowerCase() === String(name).toLowerCase() &&
    String(p?.tag || '').toLowerCase() === String(tag).toLowerCase()
  );
}

function getMatchSummary(match, me) {
  const stats = me?.stats || {};
  const rounds = safeNumber(match?.metadata?.rounds_played || match?.metadata?.rounds || 0, 0);
  const headshots = safeNumber(stats.headshots);
  const bodyshots = safeNumber(stats.bodyshots);
  const legshots = safeNumber(stats.legshots);
  const totalShots = headshots + bodyshots + legshots;
  const hs = totalShots > 0 ? Math.round((headshots / totalShots) * 100) : 0;

  let teamWon = false;
  const team = String(me?.team || '').toLowerCase();
  const teams = match?.teams;
  if (teams?.red?.has_won != null || teams?.blue?.has_won != null) {
    teamWon = team === 'red' ? !!teams.red.has_won : !!teams.blue?.has_won;
  } else if (typeof match?.won === 'boolean') {
    teamWon = match.won;
  }

  return {
    map: match?.metadata?.map || match?.map?.name || 'Unknown map',
    agent: me?.character || me?.agent || 'Unknown',
    result: teamWon ? 'W' : 'L',
    score: `${safeNumber(match?.teams?.red?.rounds_won, 0)}-${safeNumber(match?.teams?.blue?.rounds_won, 0)}`,
    startedAt: match?.metadata?.game_start_patched || match?.metadata?.started_at || match?.metadata?.started_at_raw || null,
    kda: `${safeNumber(stats.kills)} / ${safeNumber(stats.deaths)} / ${safeNumber(stats.assists)}`,
    hs,
    firstKills: safeNumber(stats.firstkills ?? stats.first_kills),
    firstDeaths: safeNumber(stats.firstdeaths ?? stats.first_deaths),
    scoreValue: safeNumber(stats.score) || (rounds > 0 ? Math.round(safeNumber(stats.damage_made) / rounds) : 0),
    kills: safeNumber(stats.kills),
    deaths: safeNumber(stats.deaths),
    assists: safeNumber(stats.assists),
    headshots,
    bodyshots,
    legshots,
  };
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const message = data?.errors?.[0]?.message || data?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

async function buildPlayerSummary(player, headers, matchCount) {
  if (!player.name || !player.tag) {
    throw new Error(`Invalid player format: ${player.raw}`);
  }

  const encodedName = encodeURIComponent(player.name);
  const encodedTag = encodeURIComponent(player.tag);
  const region = encodeURIComponent(player.region);

  const accountPromise = fetchJson(
    `https://api.henrikdev.xyz/valorant/v2/account/${encodedName}/${encodedTag}`,
    headers
  );

  const matchesPromise = fetchJson(
    `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encodedName}/${encodedTag}?size=${encodeURIComponent(matchCount)}`,
    headers
  );

  const mmrPromise = fetchJson(
    `https://api.henrikdev.xyz/valorant/v3/mmr/${region}/pc/${encodedName}/${encodedTag}`,
    headers
  ).catch(() => null);

  const [accountJson, matchesJson, mmrJson] = await Promise.all([accountPromise, matchesPromise, mmrPromise]);

  const account = accountJson?.data || {};
  const matches = Array.isArray(matchesJson?.data) ? matchesJson.data : [];

  let totalKills = 0;
  let totalDeaths = 0;
  let totalAssists = 0;
  let totalHeadshots = 0;
  let totalBodyshots = 0;
  let totalLegshots = 0;
  let totalFirstKills = 0;
  let totalFirstDeaths = 0;
  let totalScore = 0;
  let countedMatches = 0;
  const agentCounts = {};
  const recentMatches = [];

  for (const match of matches) {
    const me = getPlayerFromMatch(match, player.name, player.tag);
    if (!me) continue;

    const summary = getMatchSummary(match, me);
    recentMatches.push(summary);

    totalKills += summary.kills;
    totalDeaths += summary.deaths;
    totalAssists += summary.assists;
    totalHeadshots += summary.headshots;
    totalBodyshots += summary.bodyshots;
    totalLegshots += summary.legshots;
    totalFirstKills += summary.firstKills;
    totalFirstDeaths += summary.firstDeaths;
    totalScore += summary.scoreValue;
    countedMatches += 1;

    if (summary.agent) {
      agentCounts[summary.agent] = (agentCounts[summary.agent] || 0) + 1;
    }
  }

  const totalShots = totalHeadshots + totalBodyshots + totalLegshots;
  const hs = totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0;
  const kd = totalDeaths > 0 ? Number((totalKills / totalDeaths).toFixed(2)) : Number(totalKills.toFixed(2));
  const avgScore = countedMatches > 0 ? Math.round(totalScore / countedMatches) : 0;
  const agents = Object.entries(agentCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([agent]) => agent)
    .slice(0, 3);

  return {
    riotId: `${account?.name || player.name}#${account?.tag || player.tag}`,
    region: account?.region || player.region,
    accountLevel: account?.account_level ?? null,
    kd,
    hs,
    avgScore,
    firstKills: totalFirstKills,
    firstDeaths: totalFirstDeaths,
    kda: `${totalKills} / ${totalDeaths} / ${totalAssists}`,
    agents,
    rank: mmrJson?.data?.current?.tier?.name || null,
    rr: mmrJson?.data?.current?.rr ?? null,
    recentMatches,
  };
}

export default async function handler(req, res) {
  if (!process.env.HENRIK_API_KEY) {
    return res.status(500).json({ error: 'Missing HENRIK_API_KEY environment variable.' });
  }

  try {
    const rawPlayers = String(req.query.players || '').trim();
    const matchCount = Math.min(Math.max(safeNumber(req.query.matches, 5), 1), 10);

    if (!rawPlayers) {
      return res.status(400).json({ error: 'Missing players query parameter.' });
    }

    const players = rawPlayers.split(',').map(parsePlayer).filter((p) => p.name && p.tag);
    if (!players.length) {
      return res.status(400).json({ error: 'No valid players found. Use Name#Tag@region.' });
    }

    const headers = {
      Authorization: process.env.HENRIK_API_KEY,
      Accept: 'application/json',
    };

    const settled = await Promise.allSettled(players.map((player) => buildPlayerSummary(player, headers, matchCount)));

    const good = [];
    const errors = [];
    settled.forEach((item, index) => {
      if (item.status === 'fulfilled') good.push(item.value);
      else errors.push({ player: players[index].raw, error: item.reason?.message || 'Unknown error' });
    });

    if (!good.length) {
      return res.status(502).json({ error: 'Could not load any player stats.', errors });
    }

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      players: good,
      errors,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unexpected server error.' });
  }
}
