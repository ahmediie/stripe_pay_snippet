  const handlePayment = useCallback(
    async (type: "card" | "platform") => {
      if (googleTestEnvironment === null) return;

      if (paymentInProgressRef.current) return;
      paymentInProgressRef.current = true;
      setPaymentStarted(true);

      if (type === "platform") {
        setNativePayLoading(true);
      } else {
        setCardLoading(true);
      }

      if (!BOOKING_ID || !SERVICE_PROVIDER_ID) {
        resetPaymentState();
        console.error("Missing BOOKING_ID or SERVICE_PROVIDER_ID");
        return;
      }
      const bookingState = getBookingState();

      if (
        !bookingState.exists ||
        bookingState.isCancelled ||
        bookingState.deposit !== "pending" ||
        !bookingFee ||
        !profile?.auth_id
      ) {
        resetPaymentState();
        console.error("Payment blocked: booking invalid");
        navigation.reset({
          index: 0,
          routes: [{ name: "Home", params: { paymentIssue: true } }],
        });
        return;
      }

      if (AMOUNT <= 0) {
        resetPaymentState();
        throw new Error("Invalid deposit amount");
      }

      try {
        const response = await createPaymentIntent({
          amount: AMOUNT,
          bookingId: BOOKING_ID,
          serviceProviderId: SERVICE_PROVIDER_ID,
          userId: profile.auth_id,
          bookingFee: bookingFee,
        });

        if (!response) {
          resetPaymentState();
          throw new Error("Failed to create PaymentIntent");
        }

        if (
          (response.env === "live" && googleTestEnvironment === true) ||
          (response.env !== "live" && googleTestEnvironment === false)
        ) {
          resetPaymentState();
          throw new Error("Stripe env mismatch between client and server");
        }

        const clientSecret = response.clientSecret;

        if (type === "card") {
          const { error } = await initPaymentSheet({
            paymentIntentClientSecret: clientSecret,
            merchantDisplayName: "Niwele",
            returnURL: "niwele://stripe-redirect",
            appearance: {
              colors: { primary: colors.darkSea, error: colors.error },
              shapes: { borderRadius: 4, borderWidth: 1 },
            },
          });
          if (error) {
            resetPaymentState();
            throw error;
          }

          const result = await presentPaymentSheet();
          if (result.error) {
            resetPaymentState();
            throw result.error;
          }
        } else {
          const result = await confirmPlatformPayPayment(clientSecret, {
            applePay: {
              merchantCountryCode: "GB",
              currencyCode: "GBP",
              cartItems: [
                {
                  label: "Booking deposit",
                  amount: AMOUNT.toFixed(2),
                  paymentType: PlatformPay.PaymentType.Immediate,
                },
              ],
            },
            googlePay: {
              merchantCountryCode: "GB",
              currencyCode: "GBP",
              testEnv: googleTestEnvironment,
            },
          });
          if (result.error) {
            resetPaymentState();
            throw result.error;
          }
        }

        setPaymentConfirmed(true);
        paymentInProgressRef.current = false;
      } catch (error: any) {
        resetPaymentState();

        if (error.code !== "Canceled") {
          console.error("Payment failed", {
            message: error?.message,
            code: error?.code,
            localizedMessage: error?.localizedMessage,
          });

          // Insert payment error into Supabase
          await insertPaymentError({
            booking_id: BOOKING_ID,
            user_id: profile?.auth_id ?? null,
            service_provider_id: SERVICE_PROVIDER_ID,
            amount: AMOUNT,
            method: type,
            error_code: error?.code ?? "UNKNOWN",
            error_message: error?.message ?? "Unknown payment error",
            env: googleTestEnvironment ? "test" : "live",
          });

          navigation.reset({
            index: 0,
            routes: [{ name: "Home", params: { paymentIssue: true } }],
          });
        }
      }
    },
    [
      BOOKING_ID,
      SERVICE_PROVIDER_ID,
      AMOUNT,
      googleTestEnvironment,
      getBookingState,
      initPaymentSheet,
      presentPaymentSheet,
      confirmPlatformPayPayment,
      navigation,
    ],
  );

