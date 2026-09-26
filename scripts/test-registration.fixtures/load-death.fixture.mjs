// Dies during load before registering anything. The child already fails on
// this file; the accounting stream must still show zero registrations for it.
throw new Error("fixture load failure");
