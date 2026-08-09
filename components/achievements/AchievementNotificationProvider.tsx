"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import AchievementNotification, {
  type AchievementNotificationData,
} from "@/components/AchievementNotification";

type AchievementNotificationContextValue = {
  showAchievementNotification: (
    notification: AchievementNotificationData,
  ) => void;
  closeAchievementNotification: () => void;
};

const AchievementNotificationContext =
  createContext<AchievementNotificationContextValue | null>(
    null,
  );

type AchievementNotificationProviderProps = {
  children: ReactNode;
};

export function AchievementNotificationProvider({
  children,
}: AchievementNotificationProviderProps) {
  const [notification, setNotification] =
    useState<AchievementNotificationData | null>(null);

  const timeoutRef = useRef<number | null>(null);

  const clearNotificationTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const closeAchievementNotification = useCallback(() => {
    clearNotificationTimeout();
    setNotification(null);
  }, [clearNotificationTimeout]);

  const showAchievementNotification = useCallback(
    (newNotification: AchievementNotificationData) => {
      clearNotificationTimeout();
      setNotification(newNotification);

      timeoutRef.current = window.setTimeout(() => {
        setNotification(null);
        timeoutRef.current = null;
      }, 5000);
    },
    [clearNotificationTimeout],
  );

  useEffect(() => {
    return () => {
      clearNotificationTimeout();
    };
  }, [clearNotificationTimeout]);

  const contextValue =
    useMemo<AchievementNotificationContextValue>(
      () => ({
        showAchievementNotification,
        closeAchievementNotification,
      }),
      [
        showAchievementNotification,
        closeAchievementNotification,
      ],
    );

  return (
    <AchievementNotificationContext.Provider
      value={contextValue}
    >
      {children}

      <AchievementNotification
        notification={notification}
        onClose={closeAchievementNotification}
      />
    </AchievementNotificationContext.Provider>
  );
}

export function useAchievementNotification() {
  const context = useContext(
    AchievementNotificationContext,
  );

  if (!context) {
    throw new Error(
      "useAchievementNotification должен использоваться внутри AchievementNotificationProvider",
    );
  }

  return context;
}