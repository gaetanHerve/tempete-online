// Configuration web du projet Firebase (parties en ligne). Elle n'a rien de secret : elle
// identifie le projet, et n'importe quelle appli Firebase publiée la laisse voir. Les accès sont
// réglés par les règles de la base (database.rules.json) et par la clé du coffre (cf. online.ts).
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDeLBWPtTj-oZzB94TBO5woYvqwBGHH0xg',
  authDomain: 'tempete-sur-l-echiquier.firebaseapp.com',
  databaseURL: 'https://tempete-sur-l-echiquier-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'tempete-sur-l-echiquier',
  storageBucket: 'tempete-sur-l-echiquier.firebasestorage.app',
  messagingSenderId: '584414166498',
  appId: '1:584414166498:web:0c37a32cf08f21420b0dbb',
};
