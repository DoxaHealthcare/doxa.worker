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
    if (!docId) {
      return { success: false, error: 'Document ID is required' }
    }
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
    if (!docId) {
      return { success: false, error: 'Document ID is required' }
    }
    const db = getAdminFirestore()
    // Use set with merge: true instead of update to avoid "No document to update" errors
    await db.collection(collectionName).doc(docId).set(data, { merge: true })
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
    if (!docId) {
      return { success: false, error: 'Document ID is required' }
    }
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
    if (!docId) {
      return { success: false, error: 'Document ID is required' }
    }
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
    if (!docId) {
      return false
    }
    const db = getAdminFirestore()
    const doc = await db.collection(collectionName).doc(docId).get()
    return doc.exists
  } catch (error) {
    console.error('Error checking document existence:', error)
    throw error
  }
}
