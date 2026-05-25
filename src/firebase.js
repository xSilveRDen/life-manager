import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'

const firebaseConfig = {
  apiKey: "AIzaSyAXZT2RVuVUS0qmflfgHzgROY30Ebg3uIQ",
  authDomain: "life-manager-17332.firebaseapp.com",
  databaseURL: "https://life-manager-17332-default-rtdb.firebaseio.com",
  projectId: "life-manager-17332",
  storageBucket: "life-manager-17332.firebasestorage.app",
  messagingSenderId: "941800018409",
  appId: "1:941800018409:web:cbf337c7ad192408817b78"
}

const app = initializeApp(firebaseConfig)
export const db = getDatabase(app)
