import { createContext, useContext } from 'react';

/** True for a visitor who is not signed in: they can read, but nothing that changes state or opens Settings is offered (the server refuses it as well). */
export const ReadOnlyContext = createContext(false);
export const useReadOnly = () => useContext(ReadOnlyContext);
