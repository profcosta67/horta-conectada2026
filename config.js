// ============================================================
// Horta Conectada — configuração do app
// Este é o ÚNICO arquivo que precisa ser editado no dia a dia.
// ============================================================

window.HORTA_CONFIG = {

  // URL do Apps Script de leitura (termina em /exec).
  // Enquanto estiver vazia, o app roda em MODO DEMONSTRAÇÃO com dados simulados.
  API_URL: 'https://script.google.com/macros/s/AKfycbxVIzBm_93y567y3gAXhwk6cvZPyu5UeweMQsMgYuZ_5As2ckkRKt1-N-l1kl9Bkfw83A/exec',

  // Intervalo de leitura do ESP32, em minutos (o mesmo do firmware).
  INTERVALO_MIN: 15,

  // Atualização automática do app, em minutos.
  ATUALIZAR_MIN: 5,

  // Nomes exibidos para cada canteiro.
  CANTEIROS: {
    A: 'Canteiro A',
    B: 'Canteiro B',
  },

  // Calibração das sondas de solo (valor bruto do ADC, 0–4095).
  // Sonda resistiva: valor ALTO = seco, valor BAIXO = úmido.
  // Deixe null até concluir a calibração: o app mostra o valor bruto.
  // Depois preencha, por exemplo: { seco: 4095, molhado: 1450 }
  CALIBRACAO: {
    solo1: null,
    solo2: null,
    solo3: null,
    solo4: null,
  },

  // Faixa ideal de umidade do solo (%), usada só depois da calibração.
  SOLO_SECO_ABAIXO: 30,
  SOLO_ENCHARCADO_ACIMA: 85,
};
