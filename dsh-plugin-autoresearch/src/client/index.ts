/**
 * Public surface of the client face — a thin re-export of the dashboard
 * feature's entry slice (FSD top layer). All slices live under src/client;
 * imports point one way: shared ← entities ← features.
 */
export * from "./features/dashboard/entry";
