/* Horta Conectada — app de monitoramento (PWA)
 * Lê as leituras da planilha via Apps Script (JSON) e mostra:
 *   - status da comunicação com o ESP32
 *   - planta dos canteiros com a umidade de cada sonda
 *   - estação meteorológica (temperatura, umidade do ar, luz)
 *   - situação de cada sensor (travado, no limite, sem leitura)
 *   - gráficos de 24 h, 48 h e 7 dias
 */
(function () {
  'use strict';

  const CFG = window.HORTA_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const MODO_DEMO = !CFG.API_URL || params.has('demo');
  const INTERVALO_MS = (CFG.INTERVALO_MIN || 15) * 60 * 1000;
  const FUSO = 'America/Campo_Grande';
  const CHAVE_CACHE = 'horta:ultimas-leituras';

  const SONDAS = [
    { chave: 'solo1', nome: 'CANT_As1', canteiro: 'A' },
    { chave: 'solo2', nome: 'CANT_As2', canteiro: 'A' },
    { chave: 'solo3', nome: 'CANT_Bs1', canteiro: 'B' },
    { chave: 'solo4', nome: 'CANT_Bs2', canteiro: 'B' },
  ];

  const estado = { dias: 1, leituras: [], agora: Date.now(), recebidoEm: 0, carregando: false };
  const graficos = {};

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- formatação
  const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' });
  const fmtDia = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit' });
  const fmtCompleto = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function num(v, casas) {
    if (v === null || v === undefined || isNaN(v)) return '–';
    return v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  }

  function haQuanto(ms) {
    const min = Math.round(ms / 60000);
    if (min < 1) return 'agora mesmo';
    if (min < 60) return 'há ' + min + ' min';
    const h = Math.floor(min / 60);
    if (h < 48) return 'há ' + h + ' h' + (min % 60 && h < 6 ? ' ' + (min % 60) + ' min' : '');
    return 'há ' + Math.floor(h / 24) + ' dias';
  }

  function cssVar(nome) {
    return getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
  }

  // ---------------------------------------------------------------- calibração
  function calibrado(chave) {
    const c = (CFG.CALIBRACAO || {})[chave];
    return c && typeof c.seco === 'number' && typeof c.molhado === 'number' && c.seco !== c.molhado ? c : null;
  }

  // Converte bruto → % (0 = seco, 100 = molhado). null se não calibrado.
  function percentual(chave, bruto) {
    const c = calibrado(chave);
    if (!c || bruto === null || bruto === undefined) return null;
    const p = ((c.seco - bruto) / (c.seco - c.molhado)) * 100;
    return Math.max(0, Math.min(100, p));
  }

  const algumCalibrado = () => SONDAS.some((s) => calibrado(s.chave));

  // ---------------------------------------------------------------- dados
  async function buscarDados(dias) {
    if (MODO_DEMO) return { ok: true, agora: Date.now(), leituras: gerarDemo(dias) };

    const url = CFG.API_URL + (CFG.API_URL.includes('?') ? '&' : '?') + 'dias=' + dias + '&_=' + Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const json = await resp.json();
      if (!json.ok || !Array.isArray(json.leituras)) throw new Error('Resposta inesperada do Apps Script');
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  function salvarCache(pacote) {
    try { localStorage.setItem(CHAVE_CACHE, JSON.stringify(pacote)); } catch (e) { /* sem espaço ou modo privado */ }
  }

  function lerCache() {
    try { return JSON.parse(localStorage.getItem(CHAVE_CACHE) || 'null'); } catch (e) { return null; }
  }

  async function atualizar() {
    if (estado.carregando) return;
    estado.carregando = true;
    $('btn-atualizar').classList.add('girando');
    try {
      const json = await buscarDados(estado.dias);
      estado.leituras = json.leituras.sort((a, b) => a.t - b.t);
      estado.agora = Date.now();
      estado.recebidoEm = Date.now();
      $('faixa-offline').hidden = true;
      if (!MODO_DEMO) salvarCache({ dias: estado.dias, recebidoEm: estado.recebidoEm, leituras: estado.leituras });
    } catch (erro) {
      console.warn('Falha ao buscar dados:', erro);
      const cache = lerCache();
      if (cache && cache.leituras && !estado.leituras.length) {
        estado.leituras = cache.leituras;
        estado.recebidoEm = cache.recebidoEm;
      }
      estado.agora = Date.now();
      const faixa = $('faixa-offline');
      faixa.textContent = navigator.onLine
        ? 'Não foi possível falar com a planilha agora. Mostrando as últimas leituras salvas neste aparelho.'
        : 'Sem internet. Mostrando as últimas leituras salvas neste aparelho.';
      faixa.hidden = false;
    } finally {
      estado.carregando = false;
      $('btn-atualizar').classList.remove('girando');
      desenharTudo();
    }
  }

  // ---------------------------------------------------------------- análise
  function ultimaLeitura() {
    return estado.leituras.length ? estado.leituras[estado.leituras.length - 1] : null;
  }

  function serie(chave, n) {
    const arr = estado.leituras.map((l) => l[chave]);
    return n ? arr.slice(-n) : arr;
  }

  function statusConexao() {
    const u = ultimaLeitura();
    if (!u) return { nivel: 'offline', idade: Infinity };
    const idade = Date.now() - u.t;
    if (idade <= INTERVALO_MS * 2) return { nivel: 'online', idade };
    if (idade <= INTERVALO_MS * 4) return { nivel: 'atrasado', idade };
    return { nivel: 'offline', idade };
  }

  const leiturasEm3h = () => Math.max(3, Math.ceil(180 / (CFG.INTERVALO_MIN || 15)));

  // Verifica um sensor analógico (0–4095). Retorna { nivel, texto }.
  function analisarAnalogico(chave, opcoes) {
    const recentes = serie(chave, leiturasEm3h());
    const ultimas3 = recentes.slice(-3);
    if (!ultimas3.length || ultimas3.every((v) => v === null)) {
      return { nivel: 'falha', texto: 'Sem leitura recente.' };
    }
    if (opcoes.saturacao && ultimas3.every((v) => v !== null && v >= 4090)) {
      return { nivel: 'falha', texto: 'Preso no máximo (4095). A sonda pode estar fora do solo, solta ou desconectada.' };
    }
    if (opcoes.saturacao && ultimas3.every((v) => v !== null && v <= 5)) {
      return { nivel: 'falha', texto: 'Preso no zero. Possível curto ou fio do sinal encostado no GND.' };
    }
    const validos = recentes.filter((v) => v !== null);
    const meio = validos.length && validos[validos.length - 1] > 5 && validos[validos.length - 1] < 4090;
    if (meio && validos.length >= leiturasEm3h() && validos.every((v) => v === validos[0])) {
      return { nivel: 'atencao', texto: 'O valor não muda há 3 horas. Confira a fiação da sonda.' };
    }
    return { nivel: 'ok', texto: 'Funcionando.' };
  }

  function montarSaude() {
    const itens = [];
    const con = statusConexao();
    const u = ultimaLeitura();

    if (!u) {
      itens.push({ nivel: 'falha', titulo: 'ESP32', texto: 'Nenhuma leitura encontrada no período.' });
    } else if (con.nivel === 'online') {
      itens.push({ nivel: 'ok', titulo: 'ESP32 e Wi-Fi', texto: 'Enviando dados normalmente.' });
    } else if (con.nivel === 'atrasado') {
      itens.push({ nivel: 'atencao', titulo: 'ESP32 e Wi-Fi', texto: 'Última leitura ' + haQuanto(con.idade) + '. O esperado é a cada ' + CFG.INTERVALO_MIN + ' min.' });
    } else {
      itens.push({ nivel: 'falha', titulo: 'ESP32 e Wi-Fi', texto: 'Sem dados ' + haQuanto(con.idade) + '. Verifique a energia e o Wi-Fi do ESP32.' });
    }

    SONDAS.forEach((s) => {
      const r = analisarAnalogico(s.chave, { saturacao: true });
      itens.push({ nivel: r.nivel, titulo: s.nome + ' (' + CFG.CANTEIROS[s.canteiro] + ')', texto: r.texto });
    });

    const tempRec = serie('temp', 3);
    if (!tempRec.length || tempRec.every((v) => v === null)) {
      itens.push({ nivel: 'falha', titulo: 'DHT22', texto: 'Sem leitura de temperatura e umidade. Confira o pull-up de 10 kΩ e o fio do GPIO 25.' });
    } else if (tempRec.some((v) => v === null)) {
      itens.push({ nivel: 'atencao', titulo: 'DHT22', texto: 'Falhou em parte das últimas leituras.' });
    } else {
      itens.push({ nivel: 'ok', titulo: 'DHT22', texto: 'Funcionando.' });
    }

    ['lum1', 'lum2'].forEach((k, i) => {
      const r = analisarAnalogico(k, { saturacao: false });
      itens.push({ nivel: r.nivel, titulo: 'LDR ' + (i + 1), texto: r.texto });
    });

    if (algumCalibrado() && u) {
      SONDAS.forEach((s) => {
        const p = percentual(s.chave, u[s.chave]);
        if (p === null) return;
        if (p < CFG.SOLO_SECO_ABAIXO) itens.push({ nivel: 'atencao', titulo: 'Solo seco', texto: s.nome + ' está com ' + num(p, 0) + '% de umidade.' });
        if (p > CFG.SOLO_ENCHARCADO_ACIMA) itens.push({ nivel: 'atencao', titulo: 'Solo encharcado', texto: s.nome + ' está com ' + num(p, 0) + '% de umidade.' });
      });
    } else {
      itens.push({ nivel: 'info', titulo: 'Solo seco ou encharcado', texto: 'Os avisos passam a funcionar depois da calibração das sondas.' });
    }

    const peso = { falha: 0, atencao: 1, ok: 2, info: 3 };
    return itens.sort((a, b) => peso[a.nivel] - peso[b.nivel]);
  }

  // ---------------------------------------------------------------- desenho
  function desenharConexao() {
    const el = $('conexao');
    const con = statusConexao();
    const u = ultimaLeitura();
    el.dataset.estado = con.nivel;
    let texto;
    if (!u) texto = 'Nenhuma leitura no período';
    else if (con.nivel === 'online') texto = 'Online, última leitura ' + haQuanto(con.idade) + ' (' + fmtHora.format(u.t) + ')';
    else if (con.nivel === 'atrasado') texto = 'Leitura atrasada, a última foi ' + haQuanto(con.idade);
    else texto = 'Sem comunicação, a última leitura foi ' + haQuanto(con.idade);
    $('conexao-texto').textContent = texto;
  }

  // Cor da sonda: areia (seco) → azul-escuro (úmido)
  function corUmidade(fracaoUmida) {
    const seco = [227, 201, 143], umido = [52, 98, 140];
    const f = Math.max(0, Math.min(1, fracaoUmida));
    const c = seco.map((v, i) => Math.round(v + (umido[i] - v) * f));
    return 'rgb(' + c.join(',') + ')';
  }

  function desenharPlanta() {
    const u = ultimaLeitura();
    const saude = {};
    SONDAS.forEach((s) => { saude[s.chave] = analisarAnalogico(s.chave, { saturacao: true }); });

    const W = 360, H = 250;
    const canteiros = [
      { id: 'A', x: 14, sondas: SONDAS.filter((s) => s.canteiro === 'A') },
      { id: 'B', x: 222, sondas: SONDAS.filter((s) => s.canteiro === 'B') },
    ];
    const larg = 124, alt = 196, topo = 34;

    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Planta dos canteiros com a umidade de cada sonda">';
    svg += '<defs><pattern id="sulcos" width="14" height="14" patternUnits="userSpaceOnUse">' +
      '<ellipse cx="7" cy="7" rx="3.2" ry="1.8" fill="#5E8F48" opacity=".55"/></pattern></defs>';

    canteiros.forEach((c) => {
      svg += '<text x="' + (c.x + larg / 2) + '" y="22" text-anchor="middle" fill="#E7F0E1" font-family="Bricolage Grotesque, sans-serif" font-weight="700" font-size="15">' + esc(CFG.CANTEIROS[c.id]) + '</text>';
      svg += '<rect x="' + c.x + '" y="' + topo + '" width="' + larg + '" height="' + alt + '" rx="10" fill="#5B3F27" stroke="#7A5638" stroke-width="2"/>';
      svg += '<rect x="' + (c.x + 6) + '" y="' + (topo + 6) + '" width="' + (larg - 12) + '" height="' + (alt - 12) + '" rx="6" fill="url(#sulcos)"/>';

      c.sondas.forEach((s, i) => {
        const cy = topo + alt * (i === 0 ? 0.3 : 0.72);
        const cx = c.x + larg / 2;
        const bruto = u ? u[s.chave] : null;
        const p = percentual(s.chave, bruto);
        const fracao = p !== null ? p / 100 : (bruto === null ? 0 : 1 - bruto / 4095);
        const s_ = saude[s.chave];
        const valor = p !== null ? num(p, 0) + '%' : (bruto === null ? '–' : num(bruto, 0));
        const anel = s_.nivel === 'falha' ? '#FF8A8A' : s_.nivel === 'atencao' ? '#F2C94C' : '#F2F7EE';
        const tracejado = s_.nivel === 'ok' ? '' : ' stroke-dasharray="4 3"';

        svg += '<rect x="' + (cx - 50) + '" y="' + (cy - 30) + '" width="100" height="60" rx="12" fill="#1F4D2E" fill-opacity=".82" stroke="' + anel + '" stroke-width="2"' + tracejado + '/>';
        svg += '<circle cx="' + (cx - 32) + '" cy="' + cy + '" r="10" fill="' + corUmidade(fracao) + '" stroke="#F2F7EE" stroke-width="1.5"/>';
        svg += '<text x="' + (cx - 16) + '" y="' + (cy - 6) + '" fill="#C5D6BC" font-size="11" font-family="Atkinson Hyperlegible, sans-serif">' + esc(s.nome.replace('CANT_', '')) + '</text>';
        svg += '<text x="' + (cx - 16) + '" y="' + (cy + 16) + '" fill="#FFFFFF" font-size="19" font-weight="700" font-family="Bricolage Grotesque, sans-serif">' + valor + '</text>';
      });
    });

    // estação meteorológica no centro
    const ex = W / 2, ey = topo + alt / 2;
    svg += '<line x1="' + ex + '" y1="' + (ey - 2) + '" x2="' + ex + '" y2="' + (ey + 44) + '" stroke="#C5D6BC" stroke-width="2.5"/>';
    svg += '<circle cx="' + ex + '" cy="' + (ey - 12) + '" r="16" fill="#F2F7EE"/>';
    svg += '<path d="M' + (ex - 7) + ' ' + (ey - 12) + 'a7 7 0 1 1 14 0" fill="none" stroke="#1F4D2E" stroke-width="2.4"/>';
    svg += '<circle cx="' + ex + '" cy="' + (ey - 12) + '" r="2.6" fill="#1F4D2E"/>';
    svg += '<text x="' + ex + '" y="' + (ey + 62) + '" text-anchor="middle" fill="#C5D6BC" font-size="11" font-family="Atkinson Hyperlegible, sans-serif">estação</text>';
    svg += '</svg>';

    $('planta-svg').innerHTML = svg;
    $('planta-nota').textContent = algumCalibrado()
      ? 'Umidade do solo em %, a partir da calibração de cada sonda.'
      : 'Valor bruto da sonda, de 0 a 4095: quanto maior, mais seco. Os percentuais aparecem depois da calibração.';
  }

  function desenharClima() {
    const u = ultimaLeitura() || {};
    $('v-temp').textContent = num(u.temp, 1);
    $('v-umid').textContent = num(u.umid, 0);
    $('v-lum1').textContent = num(u.lum1, 0);
    $('v-lum2').textContent = num(u.lum2, 0);
  }

  function desenharSaude() {
    const ul = $('lista-saude');
    ul.innerHTML = '';
    const todos = montarSaude();
    const okNomes = todos.filter((i) => i.nivel === 'ok').map((i) => i.titulo.replace(/ \(.*\)$/, ''));
    const lista = todos.filter((i) => i.nivel !== 'ok');
    if (okNomes.length) {
      const resumo = { nivel: 'ok', titulo: lista.some((i) => i.nivel === 'falha' || i.nivel === 'atencao') ? 'Os demais estão normais' : 'Tudo funcionando', texto: okNomes.join(', ') + '.' };
      const pos = lista.findIndex((i) => i.nivel === 'info');
      lista.splice(pos === -1 ? lista.length : pos, 0, resumo);
    }
    lista.forEach((it) => {
      const li = document.createElement('li');
      li.dataset.nivel = it.nivel;
      li.innerHTML = '<span class="marca" aria-hidden="true"></span><strong></strong><span class="detalhe"></span>';
      li.querySelector('strong').textContent = it.titulo;
      li.querySelector('.detalhe').textContent = it.texto;
      ul.appendChild(li);
    });
  }

  // Pontos para o gráfico, com quebra visível onde houve falha de comunicação
  function pontos(chave, transformar) {
    const out = [];
    let anterior = null;
    estado.leituras.forEach((l) => {
      if (anterior && l.t - anterior > INTERVALO_MS * 2.5) out.push({ x: anterior + INTERVALO_MS, y: null });
      const v = l[chave];
      out.push({ x: l.t, y: v === null ? null : (transformar ? transformar(v) : v) });
      anterior = l.t;
    });
    return out;
  }

  // Marcas do eixo do tempo em horas "redondas" do horário de MS (UTC−4)
  const DESLOCAMENTO_MS = -4 * 3600 * 1000;
  function marcasTempo(scale) {
    const passo = (estado.dias <= 1 ? 6 : estado.dias <= 2 ? 12 : 24) * 3600 * 1000;
    const ticks = [];
    let t = Math.ceil((scale.min + DESLOCAMENTO_MS) / passo) * passo - DESLOCAMENTO_MS;
    for (; t <= scale.max; t += passo) ticks.push({ value: t });
    scale.ticks = ticks;
  }

  function opcoesBase(eixos) {
    const grade = cssVar('--linha'), tick = cssVar('--suave');
    const curto = estado.dias <= 2;
    const fim = Date.now();
    const scales = {
      x: {
        type: 'linear',
        min: fim - estado.dias * 24 * 3600 * 1000,
        max: fim,
        grid: { color: grade },
        afterBuildTicks: marcasTempo,
        ticks: {
          color: tick, maxRotation: 0,
          callback: (v) => {
            if (!curto) return fmtDia.format(v);
            const h = fmtHora.format(v);
            return h === '00:00' ? fmtDia.format(v) : h;
          },
        },
      },
    };
    Object.assign(scales, eixos);
    Object.keys(scales).forEach((k) => {
      if (k === 'x') return;
      scales[k].grid = scales[k].grid || { color: grade };
      scales[k].ticks = Object.assign({ color: tick, callback: (v) => num(v, Number.isInteger(v) ? 0 : 1) }, scales[k].ticks || {});
      if (scales[k].title) scales[k].title.color = tick;
    });
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      spanGaps: false,
      interaction: { mode: 'index', intersect: false },
      elements: { point: { radius: 0, hoverRadius: 4 }, line: { borderWidth: 2, tension: 0.25 } },
      plugins: {
        legend: { labels: { color: cssVar('--texto'), boxWidth: 12, boxHeight: 12, usePointStyle: true } },
        tooltip: {
          callbacks: {
            title: (itens) => (itens.length ? fmtCompleto.format(itens[0].parsed.x) : ''),
            label: (c) => c.dataset.label + ': ' + num(c.parsed.y, c.dataset.casas || 0) + (c.dataset.unidade || ''),
          },
        },
      },
      scales,
    };
  }

  function grafico(id, config) {
    if (graficos[id]) graficos[id].destroy();
    graficos[id] = new Chart($(id), config);
  }

  function desenharGraficos() {
    if (typeof Chart === 'undefined') {
      document.querySelectorAll('.grafico .tela').forEach((t) => {
        t.innerHTML = '<p class="nota" style="padding:20px 4px">Os gráficos precisam de internet na primeira abertura do app.</p>';
      });
      return;
    }
    Chart.defaults.font.family = "'Atkinson Hyperlegible', system-ui, sans-serif";

    const pct = algumCalibrado();
    const coresSolo = ['#8A5A32', '#C08A55', '#2E6B42', '#7FA860'];
    grafico('g-solo', {
      type: 'line',
      data: {
        datasets: SONDAS.map((s, i) => ({
          label: s.nome.replace('CANT_', ''),
          data: pontos(s.chave, pct ? (v) => percentual(s.chave, v) : null),
          borderColor: coresSolo[i], backgroundColor: coresSolo[i],
          unidade: pct ? '%' : '',
        })),
      },
      options: opcoesBase({
        y: pct
          ? { min: 0, max: 100, title: { display: true, text: 'umidade (%)' } }
          : { min: 0, max: 4095, reverse: true, title: { display: true, text: 'bruto (para cima = mais úmido)' } },
      }),
    });

    grafico('g-clima', {
      type: 'line',
      data: {
        datasets: [
          { label: 'Temperatura', data: pontos('temp'), yAxisID: 'y', borderColor: cssVar('--beterraba'), backgroundColor: cssVar('--beterraba'), unidade: ' °C', casas: 1 },
          { label: 'Umidade do ar', data: pontos('umid'), yAxisID: 'y2', borderColor: cssVar('--ceu'), backgroundColor: cssVar('--ceu'), unidade: '%' },
        ],
      },
      options: opcoesBase({
        y: { position: 'left', title: { display: true, text: '°C' } },
        y2: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '%' } },
      }),
    });

    grafico('g-luz', {
      type: 'line',
      data: {
        datasets: [
          { label: 'LDR 1', data: pontos('lum1'), borderColor: cssVar('--sol'), backgroundColor: cssVar('--sol') },
          { label: 'LDR 2', data: pontos('lum2'), borderColor: '#8C6A00', backgroundColor: '#8C6A00' },
        ],
      },
      options: opcoesBase({ y: { min: 0, max: 4095, title: { display: true, text: 'bruto' } } }),
    });
  }

  function desenharTudo() {
    desenharConexao();
    desenharPlanta();
    desenharClima();
    desenharSaude();
    desenharGraficos();
    $('rodape-fonte').textContent = MODO_DEMO
      ? 'Dados simulados para demonstração.'
      : (estado.recebidoEm ? 'Dados da planilha, atualizados às ' + fmtHora.format(estado.recebidoEm) + '.' : '');
  }

  function esc(t) {
    return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------------------------------------------------------------- modo demonstração
  function gerarDemo(dias) {
    const passo = INTERVALO_MS;
    const fim = Date.now() - 6 * 60000;
    const ini = fim - dias * 24 * 3600 * 1000;
    const out = [];
    const ruido = (a) => (Math.random() - 0.5) * a;
    const solo = [1750, 1900, 2100, 2250];
    const lacunaIni = fim - 30 * 3600 * 1000, lacunaFim = lacunaIni + 70 * 60000;

    for (let t = ini; t <= fim; t += passo) {
      if (t > lacunaIni && t < lacunaFim) continue;               // simula queda do Wi-Fi
      const h = new Date(t).getUTCHours() - 4 + new Date(t).getUTCMinutes() / 60;
      const ang = ((h - 9) / 24) * 2 * Math.PI;
      const sol = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));

      solo.forEach((v, i) => {
        let nv = v + (8 + 30 * sol) * (i < 2 ? 1 : 1.25);           // seca ao longo do dia
        if (Math.abs(h - 6) < 0.13 || Math.abs(h - 17) < 0.13) nv -= 950; // irrigação do Rain Bird
        solo[i] = Math.max(1300, Math.min(3900, nv));
      });

      const item = {
        t: t,
        lum1: Math.round(Math.max(60, 3300 * sol + 120 + ruido(140))),
        lum2: Math.round(Math.max(60, 2900 * sol + 100 + ruido(140))),
        solo1: Math.round(solo[0] + ruido(30)),
        solo2: Math.round(solo[1] + ruido(30)),
        solo3: Math.round(solo[2] + ruido(30)),
        solo4: fim - t < 5 * 3600 * 1000 ? 4095 : Math.round(solo[3] + ruido(30)), // sonda solta
        temp: +(24 + 7 * Math.sin(ang) + ruido(0.6)).toFixed(1),
        umid: +Math.max(30, Math.min(98, 70 - 22 * Math.sin(ang) + ruido(3))).toFixed(1),
      };
      out.push(item);
    }
    return out;
  }

  // ---------------------------------------------------------------- eventos
  $('btn-atualizar').addEventListener('click', atualizar);

  document.querySelectorAll('.periodos button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.periodos button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      estado.dias = parseFloat(b.dataset.dias);
      atualizar();
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - estado.recebidoEm > 60000) atualizar();
  });
  window.addEventListener('online', atualizar);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', desenharGraficos);

  setInterval(atualizar, (CFG.ATUALIZAR_MIN || 5) * 60000);
  setInterval(desenharConexao, 30000);

  $('faixa-demo').hidden = !MODO_DEMO;

  const cache = lerCache();
  if (!MODO_DEMO && cache && cache.leituras) {
    estado.leituras = cache.leituras;
    estado.recebidoEm = cache.recebidoEm;
    desenharTudo();
  }
  atualizar();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW:', e)));
  }
})();
