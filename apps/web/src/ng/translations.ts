// Plus Nigeria: every label in Funmi's app, in one place.
//
// FOR THE YORUBA REVIEW: `en` is the big line (simple English a Pidgin speaker reads easily), `yo`
// is the Yoruba shown underneath. Please check each `yo` for meaning, tone marks and how a market
// woman in Ibadan would say it; change the string here and nothing else. An empty `yo` means the
// English is shown alone (on purpose: "Stellar" and amounts stay as they are).
// Entries marked `// check` are ones we are least sure of.
//
// Piece 11: the confirm sheet and what follows it speak her language (Profile > Language): `en`
// English, `pcm` Pidgin (falls back to `en`), `yo` Yoruba as the big line (falls back to `en`).

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
  yes: { en: 'Yes', pcm: 'Yes', yo: 'Bẹ́ẹ̀ ni' },
  no: { en: 'No', pcm: 'No', yo: 'Rárá' },
  close: { en: 'Close', pcm: 'Close am', yo: 'Padé' },
  next: { en: 'Next', yo: 'Tẹ̀síwájú' },
  isThatRight: { en: 'Is that right?', pcm: 'Na true?', yo: 'Ṣé bẹ́ẹ̀ ni?' },
  checkThis: { en: 'Check this', pcm: 'Check am well', yo: 'Wò ó dáadáa' },
  sending: { en: 'Sending on Stellar…', pcm: 'E dey go on Stellar…', yo: 'Ó ń lọ…' },
  verified: { en: 'Verified on Stellar', yo: 'Ó ti wà lórí Stellar' }, // check
  done: { en: 'Done', pcm: 'E don finish', yo: 'Ó ti parí' },
  typePin: { en: 'Type your PIN', pcm: 'Type your PIN', yo: 'Tẹ PIN rẹ' },
  pinHidden: { en: 'Never tell anyone your PIN', pcm: 'No tell anybody your PIN', yo: 'Má sọ PIN rẹ fún ẹnikẹ́ni' },
  // Confirm sheet details and follow-ups ({x}: a name; {n}: a number)
  toWho: { en: 'To {x}', pcm: 'To {x}', yo: 'Sí {x}' }, // check
  fee: { en: 'Fee', pcm: 'Charge', yo: 'Owó iṣẹ́' }, // check
  total: { en: 'Total', pcm: 'Total', yo: 'Àpapọ̀' },
  cost: { en: 'Cost', pcm: 'Cost', yo: 'Owó èlé' }, // check
  totalToRepay: { en: 'Total to repay', pcm: 'Total wey you go pay back', yo: 'Àpapọ̀ tí o máa san padà' }, // check
  cancelled: { en: 'Okay, cancelled. Nothing was sent.', pcm: 'Okay, we don cancel am. Nothing comot.', yo: 'Ó dáa, a ti fagi lé e. Kò sí owó tó lọ.' }, // check
  notThrough: { en: "It didn't go through. Nothing left your wallet.", pcm: 'E no go. Nothing comot from your wallet.', yo: 'Kò lọ. Kò sí owó tó kúrò nínú àpò rẹ.' }, // check
  cashNotReceived: { en: 'Okay. That cash is marked as not received.', pcm: 'Okay. We don mark am say you no collect that cash.', yo: 'Ó dáa. A ti kọ ọ́ pé o kò gba owó náà.' }, // check
  inSeconds: { en: 'in {n} seconds', pcm: 'in {n} seconds', yo: 'ní ìṣẹ́jú-àáyá {n}' }, // check
  tickSoon: { en: 'The tick shows here in a few seconds.', pcm: 'The tick go show here in small time.', yo: 'Àmì á hàn níbí láìpẹ́.' }, // check
  onPlus: { en: 'On Plus: straight to their wallet.', pcm: 'Dem dey Plus: e go straight enter their wallet.', yo: 'Wọ́n wà lórí Plus: ó lọ tààrà sí àpò owó wọn.' }, // check
  cashOutInfo: { en: 'You get a code. Show it to the agent and collect your cash.', pcm: 'You go get code. Show the agent, collect your cash.', yo: 'Wàá gba kóòdù kan. Fi han aṣojú, kí o sì gba owó rẹ.' }, // check
  intoSavings: { en: 'Into your savings: {x}', pcm: 'Put am for your savings: {x}', yo: 'Sínú owó ìpamọ́ rẹ: {x}' }, // check
  fromSavings: { en: 'From your savings to your wallet', pcm: 'Comot from your savings enter your wallet', yo: 'Láti owó ìpamọ́ sí àpò owó rẹ' }, // check
  backToWallet: { en: 'Back to your wallet, on Stellar.', pcm: 'E go back enter your wallet, on Stellar.', yo: 'Ó padà sí àpò owó rẹ, lórí Stellar.' }, // check
  savedPerson: { en: 'Saved {x}. Next time, pick them from Saved people.', pcm: 'We don save {x}. Next time, pick dem from Saved people.', yo: 'A ti fi {x} pamọ́. Nígbà míì, yàn wọ́n nínú Àwọn tí o fi pamọ́.' }, // check
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

  // Loan (piece 4)
  loan: { en: 'Loan', yo: 'Owó yíyá' }, // check
  buildingHistory: { en: 'Building your Plus history', yo: 'À ń kọ́ ìtàn Plus rẹ' }, // check
  estimateNotOffer: { en: 'Estimate, not an offer', yo: 'Ìṣirò ni, kì í ṣe ìfilọ̀' }, // check
  youReceive: { en: 'You receive', yo: 'Ìwọ yóò gbà' }, // check
  whyThisOffer: { en: 'Why you got this offer', yo: 'Ìdí tí o fi rí èyí' }, // check
  nextLoans: { en: 'Repay well, and next time', yo: 'San dáadáa, nígbà míì' }, // check
  acceptLoan: { en: 'Accept with my PIN', yo: 'Gbà á pẹ̀lú PIN mi' }, // check
  repayNow: { en: 'Repay now', yo: 'San báyìí' }, // check
  needMoreTime: { en: 'I need more time', yo: 'Mo nílò àkókò sí i' }, // check
  smallerPayments: { en: 'Smaller payments', yo: 'Ìsanwó kékeré' }, // check
  nobodyElse: { en: 'Plus never contacts anyone else about your loan.', yo: 'Plus kò ní kàn sí ẹlòmíì nípa owó tí o yá.' }, // check

  // Savings (piece 11)
  savings: { en: 'Savings', yo: 'Owó ìpamọ́' }, // check
  goal: { en: 'Goal', yo: 'Àfojúsùn' }, // check
  addToSavings: { en: 'Add to savings', yo: 'Fi kún owó ìpamọ́' }, // check
  takeOut: { en: 'Take out', yo: 'Mú jáde' }, // check
  autoSave: { en: 'Auto-save', yo: 'Ìpamọ́ aládàáṣe' }, // check
  autoSaveHow: { en: 'Of every money-in, after any loan payment', yo: 'Nínú owó tó bá wọlé, lẹ́yìn ìsanwó owó yíyá' }, // check
  setGoal: { en: 'Set my goal', yo: 'Ṣètò àfojúsùn mi' }, // check
  onlyYou: { en: 'Held on Stellar, apart from your spending money. Only you can take it out.', pcm: 'E dey for Stellar, separate from your spending money. Na only you fit comot am.', yo: 'Ó wà lórí Stellar, lọ́tọ̀ sí owó ìnáwó rẹ. Ìwọ nìkan ló lè mú un jáde.' }, // check

  // Assets (piece 5)
  assets: { en: 'Assets', yo: 'Ohun ìní' }, // check
  addAsset: { en: 'Add something you own', yo: 'Fi ohun tí o ní kún un' }, // check
  takeAssetPhoto: { en: 'Take the photo', yo: 'Ya fọ́tò náà' }, // check
  askWitnesses: { en: 'Ask two people to confirm', yo: 'Ní kí ènìyàn méjì jẹ́rìí' }, // check
  askInspection: { en: 'Ask an agent to inspect it', yo: 'Ní kí aṣojú wò ó' }, // check
  confirmForThem: { en: 'Someone asked you to confirm', yo: 'Ẹnìkan ní kí o jẹ́rìí' }, // check
  iConfirm: { en: 'Yes, I have seen it', yo: 'Bẹ́ẹ̀ni, mo ti rí i' }, // check
  cantConfirm: { en: "I can't confirm", yo: 'Mi ò lè jẹ́rìí' }, // check

  // Cash out
  showCode: { en: 'Show the agent this code', pcm: 'Show the agent this code', yo: 'Fi kóòdù yìí han aṣojú' },
  newCode: { en: 'Show code', yo: 'Fi kóòdù hàn' },

  // Settings
  signOut: { en: 'Sign out', yo: 'Jáde' },

  // Sign-up (onboarding) and sign-in
  openAccount: { en: 'Open a Plus account', yo: 'Ṣí àkáǹtì Plus' }, // check
  haveAccount: { en: 'I have an account', yo: 'Mo ti ní àkáǹtì' }, // check
  stepName: { en: 'Name', yo: 'Orúkọ' },
  stepLanguage: { en: 'Language', yo: 'Èdè' },
  stepPhone: { en: 'Phone', yo: 'Fóònù' },
  stepPin: { en: 'PIN', yo: 'PIN' },
  stepVerify: { en: 'Check it is you', yo: 'Ìdánilójú' }, // check
  stepWallet: { en: 'Wallet ready', yo: 'Àpò owó ti ṣetán' }, // check
  whatName: { en: 'What should Plus call you?', yo: 'Kí ni orúkọ rẹ?' },
  whichLanguage: { en: 'Which language do you like?', yo: 'Èdè wo lo fẹ́ràn?' },
  yourPhone: { en: 'Your phone number', yo: 'Nọ́mbà fóònù rẹ' },
  typeCode: { en: 'Type the code we sent', yo: 'Tẹ kóòdù tí a fi ránṣẹ́' }, // check
  choosePin: { en: 'Choose a PIN', yo: 'Yan PIN kan' },
  pinAgain: { en: 'Type the same PIN again', yo: 'Tẹ PIN náà lẹ́ẹ̀kan sí i' }, // check
  takePhoto: { en: 'A quick photo', yo: 'Fọ́tò kékeré kan' }, // check
  addNin: { en: 'Add your NIN', yo: 'Fi NIN rẹ kún un' }, // check
  trusted: { en: 'Someone you trust', yo: 'Ẹni tí o fọkàn tán' },
  openWallet: { en: 'Open my wallet', yo: 'Ṣí àpò owó mi' },
  ready: { en: 'Your account is ready', yo: 'Àkáǹtì rẹ ti ṣetán' },
  goToWallet: { en: 'Go to my wallet', yo: 'Lọ sí àpò owó mi' },
  skip: { en: 'Skip for now', yo: 'Fi sílẹ̀ ná' },
  signIn: { en: 'Sign in', yo: 'Wọlé' },

  // Money in and pay by phone
  addMoney: { en: 'Add money', yo: 'Fi owó sí' },
  add: { en: 'Add', yo: 'Fi kún' }, // check
  bankTransfer: { en: 'Bank transfer', yo: 'Owó láti báǹkì' }, // check
  agentCash: { en: 'Cash with an agent', yo: 'Owó lọ́wọ́ aṣojú' }, // check
  savedPeople: { en: 'Saved people', yo: 'Àwọn tí o fi pamọ́' }, // check
  newNumber: { en: 'By phone number', yo: 'Nọ́mbà fóònù' },
  toBank: { en: 'To a bank', yo: 'Sí báǹkì' }, // check
  accountName: { en: 'Account name', yo: 'Orúkọ àkáǹtì' }, // check
  saveThisPerson: { en: 'Save this person', pcm: 'Save this person', yo: 'Fi ẹni yìí pamọ́' }, // check

  // The mic
  speak: { en: 'Talk to Plus', yo: 'Sọ̀rọ̀' },
  micListening: { en: 'I dey listen…', yo: '' },
  micSpeaking: { en: 'Plus dey talk…', yo: '' },
  micConnecting: { en: 'Connecting…', yo: '' },
  micStop: { en: 'Tap to stop', yo: '' },
  micError: { en: 'Voice no dey work now', yo: '' },
  micSoon: { en: 'Voice coming soon', yo: 'Ohùn ń bọ̀ láìpẹ́' }, // check
} as const
