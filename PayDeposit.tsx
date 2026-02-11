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

  const amountFormatted = useMemo(() => AMOUNT.toFixed(2), [AMOUNT]);

  if (
    bookingFee === null ||
    !business ||
    booking === null ||
    booking.full_amount === null ||
    googleTestEnvironment === null
  ) {
    return <FullScreenLoading />;
  }

  if (paymentConfirmed && booking?.deposit !== "paid" && !booking.full_amount) {
    return <FullScreenLoading />;
  }

  return (
    <View style={styles.container}>
      <ScrollView style={{ padding: 16, flex: 1, width: windowWidth }} showsVerticalScrollIndicator={false}>
        <CustomText
          level="displaySmall"
          color={colors.deepSea}
          style={{ marginTop: 16, marginBottom: 8, marginHorizontal: 16 }}
        >
          Book appointment
        </CustomText>

        <View style={{ width: "100%", marginHorizontal: 16 }}>
          <LabelValueCombo
            label="Location"
            value={business?.full_address ? business?.full_address : `${business?.city}, ${business?.country}`}
          />
          <LabelValueCombo
            label="Reserved slot"
            value={`${formattedDate(booking.date)}, ${booking.start_time.substring(
              0,
              5,
            )} - ${booking.end_time.substring(0, 5)}`}
          />

          <LabelValueCombo label="Service" value={booking.service_name} />
          {booking.service_type && <LabelValueCombo label="Service option" value={booking.service_type} />}
          <LabelValueCombo
            label="Booking deposit"
            value={`£${amountFormatted} ${
              booking.refundable ? `(Includes £${bookingFee.toFixed(2)} booking fee )` : ""
            }`}
          />
          <LabelValueCombo
            label="payment after service"
            value={`£${(booking.full_amount - (booking.deposit_amount ?? 0)).toFixed(2)}`}
          />
          <LabelValueCombo label="Total price" value={`£${booking.full_amount.toFixed(2)}`} />
        </View>
        <CancelPolicy refundable={booking.refundable} />
        <View style={{ height: 280 }} />
      </ScrollView>

      <View style={styles.paymentOptions}>
        <View style={styles.paymentAmountContainer}>
          <CustomText color={colors.deepSea}>Booking deposit</CustomText>
          <CustomText level="header" color={colors.deepSea} textAlign="right">
            £{amountFormatted}
          </CustomText>
        </View>

        {platformPaySupported && (
          <CustomPayButton
            type={Platform.OS === "ios" ? "Apple" : "Google"}
            onPress={() => handlePayment("platform")}
            loading={nativePayLoading || !BOOKING_ID || !SERVICE_PROVIDER_ID}
          />
        )}

        <CustomPayButton
          type={platformPaySupported ? "Card" : "CardPrimary"}
          onPress={() => handlePayment("card")}
          loading={cardLoading || !BOOKING_ID || !SERVICE_PROVIDER_ID}
        />
      </View>
    </View>
  );
};
