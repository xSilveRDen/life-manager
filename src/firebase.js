import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'

const firebaseConfig = {
  apiKey: "AIzaSyACigrDT1_f5aXn83_vY9FuxrfMx-jfB_8",
  authDomain: "life-manager-97a23.firebaseapp.com",
  databaseURL: "https://life-manager-97a23-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "life-manager-97a23",
  storageBucket: "life-manager-97a23.firebasestorage.app",
  messagingSenderId: "319273793166",
  appId: "1:319273793166:web:75667ba79f930bb26f7bdf"
}

const app = initializeApp(firebaseConfig)
export const db = getDatabase(app)
