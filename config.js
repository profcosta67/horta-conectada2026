// ============================================================
// Horta Conectada 2026 — configuração do app
// Este é o ÚNICO arquivo que precisa ser editado no dia a dia.
// ============================================================

window.HORTA_CONFIG = {

  // URL do Apps Script de leitura (termina em /exec).
  // Enquanto estiver vazia, o app roda em MODO DEMONSTRAÇÃO com dados simulados.
  API_URL: 'https://script.google.com/macros/s/AKfycbxVIzBm_93y567y3gAXhwk6cvZPyu5UeweMQsMgYuZ_5As2ckkRKt1-N-l1kl9Bkfw83A/exec',

  // Intervalo de leitura do ESP32, em minutos (o MESMO valor do firmware).
  //   Teste em casa: 7200000UL  → 120
  //   Campo:          900000UL  → 15
  INTERVALO_MIN: 120,

  // Atualização automática do app, em minutos.
  ATUALIZAR_MIN: 5,

  // Nomes exibidos para cada canteiro e cada sensor.
  CANTEIROS: { A: 'Canteiro A', B: 'Canteiro B' },
  NOMES: { solo1: 'Sensor 1', solo2: 'Sensor 2', solo3: 'Sensor 3', solo4: 'Sensor 4' },

  // ---------------------------------------------------------------
  // FAIXAS DO SOLO (valor bruto 0–4095; ALTO = seco, BAIXO = úmido)
  // Base provisória até a calibração. Ajuste conforme o campo.
  //   acima de SECO_ACIMA ............ Seco
  //   entre os dois ................... Adequado
  //   abaixo de ENCHARCADO_ABAIXO ..... Encharcado
  // ---------------------------------------------------------------
  SOLO_BRUTO: { SECO_ACIMA: 3500, ENCHARCADO_ABAIXO: 1500 },

  // Depois da calibração, preencha { seco: <bruto no seco>, molhado: <bruto saturado> }.
  // Com isso o app passa a usar % e as faixas SOLO_PCT abaixo.
  CALIBRACAO: { solo1: null, solo2: null, solo3: null, solo4: null },
  SOLO_PCT: { SECO_ABAIXO: 30, ENCHARCADO_ACIMA: 85 },

  // ---------------------------------------------------------------
  // FAIXAS DE LUMINOSIDADE (valor bruto do LDR; ALTO = mais luz)
  //   abaixo de NOITE_ABAIXO ......... Noite
  //   até NUBLADO_ATE ................ Nublado
  //   até CEU_LIMPO_ATE .............. Céu limpo
  //   acima .......................... Ensolarado
  // ---------------------------------------------------------------
  LUZ_BRUTO: { NOITE_ABAIXO: 200, NUBLADO_ATE: 1500, CEU_LIMPO_ATE: 3000 },

  // ---------------------------------------------------------------
  // EQUIPE (aparece no rodapé e na aba Sobre)
  // ---------------------------------------------------------------
  EQUIPE: {
    COORDENADORES: [
      'Prof. Dr. Marcelo Augusto de Souza Costa',
      'Profa. Dra. Michele da Silva Gomes',
    ],
    BOLSISTAS: [
      'Caio Felipe Araujo da Silva',
      'Kelmilly da Aguiar Guidorize',
      'Maria Eduarda Ramos Santos',
      'Renan Augusto Alves Pereira',
    ],
  },

  // ---------------------------------------------------------------
  // CRITÉRIOS DAS RECOMENDAÇÕES (dados cruzados) — ajustar com o tempo
  // ---------------------------------------------------------------
  CLIMA: {
    TEMP_QUENTE: 30,        // °C a partir do qual o dia é considerado quente
    TEMP_FRIO: 20,          // °C abaixo do qual o dia é considerado frio
    UMID_AR_SECO: 45,       // % abaixo do qual o ar é considerado seco
    UMID_AR_CHUVA: 90,      // % acima do qual há indício de chuva / tempo fechado
  },
};
