const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (request.method !== 'GET') return json({ ok: false, error: 'GET only' }, 405);
    const id = url.searchParams.get('event') || '';
    if (!/^\d{5,20}$/.test(id)) return json({ ok: false, error: 'Geçersiz ESPN maç ID' }, 400);

    const leagues = ['tur.1','eng.1','esp.1','ger.1','ita.1','uefa.champions','uefa.europa','uefa.europa.conf','uefa.nations'];
    for (const league of leagues) {
      try {
        const endpoint = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/summary?event=${encodeURIComponent(id)}`;
        const response = await fetch(endpoint, { headers: { 'Accept': 'application/json', 'User-Agent': 'FUTBOLBARBAROS/1.0' } });
        if (!response.ok) continue;
        const data = await response.json();
        const header = data.header || {};
        if (String(header.id || '') !== id) continue;
        const comp = (header.competitions || []).find(x => x.competitors?.length >= 2);
        if (!comp) continue;
        const home = comp.competitors.find(x => x.homeAway === 'home');
        const away = comp.competitors.find(x => x.homeAway === 'away');
        if (!home || !away || !header.competitions?.[0]?.date) continue;
        const kickoff = header.competitions[0].date || comp.date || header.season?.startDate;
        if (!kickoff) continue;
        return json({ ok: true, match: { espnId: id, homeTeam: home.team?.displayName || home.team?.name || home.displayName, awayTeam: away.team?.displayName || away.team?.name || away.displayName, competition: comp.series?.title || data.leagues?.[0]?.name || header.season?.name || 'Futbol', kickoff, leagueCode: league } });
      } catch (e) { /* Try the next ESPN competition code. */ }
    }
    return json({ ok: false, error: 'Bu ID seçili ESPN liglerinde bulunamadı veya maç bilgisi henüz yayınlanmadı.' }, 404);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
}
