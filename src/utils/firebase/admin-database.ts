import { DocumentData } from 'firebase-admin/firestore'
import { getAdminFirestore } from './admin.js'

interface DatabaseResponse {
  success: boolean
  data?: DocumentData | null
  error?: string
}

export const createDBAdmin = async (
  collectionName: string,
  docId: string,
  data: DocumentData
): Promise<DatabaseResponse> => {
  try {
    const db = getAdminFirestore()
    await db.collection(collectionName).doc(docId).set(data)
    return { success: true }
  } catch (error) {
    console.error('Error creating document:', error)
    throw error
  }
}

export const updateDBAdmin = async (
  collectionName: string,
  docId: string,
  data: Partial<DocumentData>
): Promise<DatabaseResponse> => {
  try {
    const db = getAdminFirestore()
    await db.collection(collectionName).doc(docId).update(data)
    return { success: true }
  } catch (error) {
    console.error('Error updating document:', error)
    throw error
  }
}

export const getDBAdmin = async (
  collectionName: string,
  docId: string
): Promise<DatabaseResponse> => {
  try {
    const db = getAdminFirestore()
    const doc = await db.collection(collectionName).doc(docId).get()

    if (doc.exists) {
      return { data: doc.data(), success: true }
    } else {
      return { data: null, success: false, error: 'Document not found' }
    }
  } catch (error) {
    console.error('Error getting document:', error)
    throw error
  }
}

export const deleteDBAdmin = async (
  collectionName: string,
  docId: string
): Promise<DatabaseResponse> => {
  try {
    const db = getAdminFirestore()
    await db.collection(collectionName).doc(docId).delete()
    return { success: true }
  } catch (error) {
    console.error('Error deleting document:', error)
    throw error
  }
}

export const checkIsExistsDBAdmin = async (
  collectionName: string,
  docId: string
): Promise<boolean> => {
  try {
    const db = getAdminFirestore()
    const doc = await db.collection(collectionName).doc(docId).get()
    return doc.exists
  } catch (error) {
    console.error('Error checking document existence:', error)
    throw error
  }
}
