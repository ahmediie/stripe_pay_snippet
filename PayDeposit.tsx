import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet, Platform } from "react-native";
import { useStripe, usePlatformPay, PlatformPay } from "@stripe/stripe-react-native";
import colors from "../config/colors";
import { windowWidth } from "../config/universalMeasurements";
import CustomPayButton from "../components/CustomPayButton";
import CustomText from "../components/CustomText";
import { useNavigation, useRoute } from "@react-navigation/native";
import { sharedStyles } from "../Styles/sharedStyles";
import IconButton from "../components/IconButton";
import { BookingProps, cancelBookingById, getBookingsById, listenToBookingById } from "../supabase/bookings";
import { getServiceById, ServiceProps } from "../supabase/services";
import { ScrollView } from "react-native-gesture-handler";
import LabelValueCombo from "../components/LabelValueCombo";
import FullScreenLoading from "../components/FullScreenLoading";
import getBusinessById, { BusinessProps } from "../supabase/businesses";
import formattedDate from "../functions/formattedDate";
import calculateBookingFee from "../functions/calculateBookingFee";
import { useStoreState } from "../store/store";
import getPublicKeys, { KeyProps } from "../supabase/keys";
import { createPaymentIntent } from "../stripe/CreatePaymentIntent";
import { insertPaymentError } from "../supabase/payment_errors";
import CancelPolicy from "../components/CancelPolicy";

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const PayDeposit = () => {
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { isPlatformPaySupported, confirmPlatformPayPayment } = usePlatformPay();

  const [platformPaySupported, setPlatformPaySupported] = useState(false);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [selectedService, setSelectedService] = useState<ServiceProps | null>(null);
  const [business, setBusiness] = useState<BusinessProps | null>(null);
  const [bookingFee, setBookingFee] = useState<number | null>(null);
  const [booking, setBooking] = useState<BookingProps | null>(null);
  const [nativePayLoading, setNativePayLoading] = useState<boolean>(false);
  const [cardLoading, setCardLoading] = useState<boolean>(false);
  const [googleTestEnvironment, setGoogleTestEnvironment] = useState<boolean | null>(null);
  const [paymentStarted, setPaymentStarted] = useState(false);

  const paymentInProgressRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { profile } = useStoreState();

  const navigation = useNavigation<any>();
  const route = useRoute<any>();

  const BOOKING_ID = route.params?.booking_id ?? null;
  const SERVICE_PROVIDER_ID = route.params?.service_provider_id ?? null;
  const SERVICE_ID = route.params?.service_id ?? null;
  const AMOUNT = booking?.deposit_amount || 0;

  // -----------------------------
  // Cancel booking handler
  // -----------------------------
  const cancelBooking = async () => {
    if (!BOOKING_ID) return;

    // NOTE: Always re-fetch latest booking state before cancelling
    const latest = await getBookingsById(BOOKING_ID);
    const current = latest?.[0];
    // NOTE: Never cancel once payment has started or completed
    if (paymentStarted || paymentConfirmed || current?.deposit === "paid") {
      return;
    }

    await cancelBookingById(BOOKING_ID, "cancelled due to payment issue");
    navigation.reset({ index: 0, routes: [{ name: "Home" }] });
  };

  // -----------------------------
  // Header setup
  // -----------------------------
  useEffect(() => {
    navigation.setOptions({
      headerTitleAlign: "left",
      headerTitle: "",
      headerLeft: null,
      headerRight: () => (
        <View style={sharedStyles.headerButtonRight}>
          <IconButton
            color={colors.deepSea}
            icon="Cross"
            onPress={() => {
              if (!paymentStarted && !paymentConfirmed) {
                void cancelBooking();
              }
            }}
          />
        </View>
      ),
      headerShadowVisible: false,
    });
  }, [navigation, paymentStarted, paymentConfirmed]);

  useEffect(() => {
    async function fetchKeys() {
      const keys: KeyProps | null = await getPublicKeys();
      if (!keys) return;

      const googleTestEnvironment = keys.current_env === "live" ? false : true;

      setGoogleTestEnvironment(googleTestEnvironment);
    }

    fetchKeys();
  }, [profile?.auth_id]);

  // -----------------------------
  // Fetch selected service and business details
  // -----------------------------
  useEffect(() => {
    const fetchService = async () => {
      if (SERVICE_ID) {
        const service = await getServiceById(SERVICE_ID);
        if (service) {
          const business = await getBusinessById(service.business_id);
          if (business && business.length > 0) {
            //console.log("fetched business:", JSON.stringify(business[0], null, 2));
            setBusiness(business[0]);
          }
          setSelectedService(service);
        } else {
          console.warn("Service not found in PayDeposit for ID:", SERVICE_ID);
        }
      }
    };

    void fetchService();
  }, [SERVICE_ID]);

  useEffect(() => {
    const fetchBooking = async () => {
      if (BOOKING_ID) {
        const booking = await getBookingsById(BOOKING_ID);
        if (booking && booking.length > 0) {
          setBooking(booking[0]);
        } else {
          console.warn("Booking not found in PayDeposit for ID:", BOOKING_ID);
        }
      }
    };

    void fetchBooking();
  }, [BOOKING_ID]);

  useEffect(() => {
    if (!BOOKING_ID) return;

    const unsubscribe = listenToBookingById(BOOKING_ID, (updatedBooking) => {
      setBooking(updatedBooking);
    });

    return () => {
      unsubscribe();
    };
  }, [BOOKING_ID]);

  useEffect(() => {
    if (booking?.deposit === "paid") {
      navigation.reset({
        index: 0,
        routes: [{ name: "Home", params: { booked: true } }],
      });
    }
  }, [booking?.deposit, navigation]);

  useEffect(() => {
    if (booking?.is_cancelled) {
      navigation.reset({
        index: 0,
        routes: [{ name: "Home", params: { paymentCancelled: true } }],
      });
    }
  }, [booking?.is_cancelled]);

  // When service or deposit changes, calculate fee
  useEffect(() => {
    if (selectedService?.deposit !== undefined && booking) {
      const validatedDeposit = typeof booking.deposit_amount === "number" ? booking.deposit_amount : 0;
      (async () => {
        const fee = await calculateBookingFee(validatedDeposit);
        setBookingFee(fee);
      })();
    }
  }, [selectedService, booking]);

  // -----------------------------
  // 5-minute inactivity timeout
  // -----------------------------

  useEffect(() => {
    timeoutRef.current = setTimeout(async () => {
      if (!paymentInProgressRef.current && !paymentStarted && !paymentConfirmed) {
        await cancelBooking();
      }
    }, INACTIVITY_TIMEOUT_MS);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [paymentStarted, paymentConfirmed]);

  // -----------------------------
  // Platform Pay support
  // -----------------------------
  useEffect(() => {
    (async () => {
      const supported = await isPlatformPaySupported();
      setPlatformPaySupported(supported);
    })();
  }, [isPlatformPaySupported]);

  // -----------------------------
  // Booking existence check
  // -----------------------------
  const getBookingState = () => {
    if (!booking) return { exists: false };

    return {
      exists: true,
      isCancelled: booking.is_cancelled,
      deposit: booking.deposit,
    };
  };

  // -----------------------------
  // Generic payment handler
  // -----------------------------

  const resetPaymentState = () => {
    paymentInProgressRef.current = false;
    setPaymentStarted(false);
    setNativePayLoading(false);
    setCardLoading(false);
  };

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

export default PayDeposit;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: "100%",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.clear,
  },
  paymentOptions: {
    width: windowWidth,
    alignItems: "center",
    justifyContent: "center",
    position: "absolute",
    bottom: 0,
    paddingBottom: Platform.OS === "ios" ? 32 : 40,
    backgroundColor: colors.clear,
  },
  paymentAmountContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    width: windowWidth,
    paddingHorizontal: 16,
    height: 48,
    borderTopWidth: 1,
    borderColor: colors.rain,
  },
});
