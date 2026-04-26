import { createDispatchLedgerStore } from "@/lib/sqlite/dispatchLedgerStoreFactory.js";

const imageStore = createDispatchLedgerStore({
  requestsTable: "image_dispatch_requests",
  attemptsTable: "image_dispatch_attempts",
  eventsTable: "image_dispatch_events",
});

export const insertImageDispatchRequest = imageStore.insertRequest;
export const getImageDispatchRequest = imageStore.getRequest;
export const updateImageDispatchRequestStatus = imageStore.updateRequestStatus;
export const listQueuedImageDispatchRequests = imageStore.listQueuedRequests;
export const insertImageDispatchAttempt = imageStore.insertAttempt;
export const getImageDispatchAttempt = imageStore.getAttempt;
export const getLatestImageDispatchAttemptForRequest =
  imageStore.getLatestAttemptForRequest;
export const listActiveImageDispatchAttempts = imageStore.listActiveAttempts;
export const listImageDispatchAttemptsByState = imageStore.listAttemptsByState;
export const leaseImageDispatchAttempt = imageStore.leaseAttempt;
export const transitionImageDispatchAttempt = imageStore.transitionAttempt;
export const insertImageDispatchAttemptEvent = imageStore.insertAttemptEvent;
export const listImageDispatchAttemptEvents = imageStore.listAttemptEvents;
export const clearImageDispatchTables = imageStore.clearTables;
export const pruneImageDispatchLedger = imageStore.pruneLedger;
