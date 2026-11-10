// Plus Nigeria: every label in Funmi's app, in one place.
//
// FOR THE YORUBA REVIEW: `en` is the big line (simple English a Pidgin speaker reads easily), `yo`
// is the Yoruba shown underneath. Please check each `yo` for meaning, tone marks and how a market
// woman in Ibadan would say it; change the string here and nothing else. An empty `yo` means the
// English is shown alone (on purpose: "Stellar" and amounts stay as they are).
// Entries marked `// check` are ones we are least sure of.

export const W = {
  // Home and navigation
  hello: { en: 'Hello', yo: 'Báwo ni' },
  wallet: { en: 'Your wallet', yo: 'Àpò owó rẹ' },
  onStellar: { en: 'Your wallet is on Stellar', yo: '' },
  home: { en: 'Home', yo: 'Ilé' },
  addCash: { en: 'Add cash', yo: 'Fi owó sí' },
  pay: { en: 'Pay', yo: 'Sanwó' },
  ajo: { en: 'Ajo', yo: 'Àjọ' },
  advance: { en: 'Advance', yo: 'Yá owó' },
  cashOut: { en: 'Cash out', yo: 'Gba owó' },
  record: { en: 'My record', yo: 'Ìwé mi' },
  settings: { en: 'Settings', yo: 'Ètò' },
  latest: { en: 'Latest', yo: 'Èyí tó ṣẹ̀ṣẹ̀ ṣẹlẹ̀' }, // check

  // Confirm sheet
  yes: { en: 'Yes', yo: 'Bẹ́ẹ̀ ni' },
  no: { en: 'No', yo: 'Rárá' },
  close: { en: 'Close', yo: 'Padé' },
  next: { en: 'Next', yo: 'Tẹ̀síwájú' },
  isThatRight: { en: 'Is that right?', yo: 'Ṣé bẹ́ẹ̀ ni?' },
  checkThis: { en: 'Check am well', yo: 'Wò ó dáadáa' },
  sending: { en: 'Sending on Stellar…', yo: 'Ó ń lọ…' },
  verified: { en: 'Verified on Stellar', yo: 'Ó ti wà lórí Stellar' }, // check
  done: { en: 'Done', yo: 'Ó ti parí' },
  typePin: { en: 'Type your PIN', yo: 'Tẹ PIN rẹ' },
  pinHidden: { en: 'No tell anybody your PIN', yo: 'Má sọ PIN rẹ fún ẹnikẹ́ni' },
  waiting: { en: 'Waiting for your answer', yo: 'Ó ń dúró dè ọ́' },

  // Pay
  whoPay: { en: 'Who you wan pay?', yo: 'Ta ni o fẹ́ san fún?' },
  howMuch: { en: 'How much?', yo: 'Èló ni?' },

  // Ajo
  members: { en: 'Members', yo: 'Àwọn ọmọ ẹgbẹ́' },
  turn: { en: 'Turn', yo: 'Ìgbà' },
  paid: { en: 'Paid', yo: 'Ó ti san' },
  notYet: { en: 'Not yet', yo: 'Kò tíì san' },
  payMyPart: { en: 'Pay my part', yo: 'San ìpín mi' },

  // Advance
  takeAdvance: { en: 'Take an advance', yo: 'Yá owó' },
  oneFee: { en: 'One fee', yo: 'Owó kan ṣoṣo' }, // check
  noInterest: { en: 'No interest', yo: 'Kò sí èlé' },
  noLateFees: { en: 'No late fees', yo: 'Kò sí owó ìjìyà' }, // check
  repaysItself: { en: 'Pays back by itself', yo: 'Ó ń san ara rẹ̀ padà' }, // check
  ifBehind: { en: 'If you fall behind, your limit pauses until it is paid back.', yo: 'Tí o bá pẹ́ láti san, a ó dá ìyá owó dúró títí o fi san án.' }, // check
  nobodyCalled: { en: 'Nobody is called or contacted.', yo: 'A kò ní pe ẹnikẹ́ni.' }, // check

  // Cash out
  showCode: { en: 'Show the agent this code', yo: 'Fi kóòdù yìí han aṣojú' },
  newCode: { en: 'Show code', yo: 'Fi kóòdù hàn' },

  // Settings
  signOut: { en: 'Sign out', yo: 'Jáde' },

  // The mic
  speak: { en: 'Talk to Plus', yo: 'Sọ̀rọ̀' },
  micListening: { en: 'I dey listen…', yo: '' },
  micSpeaking: { en: 'Plus dey talk…', yo: '' },
  micConnecting: { en: 'Connecting…', yo: '' },
  micStop: { en: 'Tap to stop', yo: '' },
  micError: { en: 'Voice no dey work now', yo: '' },
  micSoon: { en: 'Voice coming soon', yo: 'Ohùn ń bọ̀ láìpẹ́' }, // check
} as const
